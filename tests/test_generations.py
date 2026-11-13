"""Local source adoption must keep active Python and Node children consistent."""
import json
import importlib.util
import os
import py_compile
from pathlib import Path
import subprocess
import sys

import pytest
import treadway
from treadway.generations import GenerationError, GenerationStore, Source, fingerprint


def fixture(tmp_path):
    source = tmp_path / 'source'
    package = source / 'demo'
    package.mkdir(parents=True)
    (package / '__init__.py').write_text('')
    (package / 'later.py').write_text("VALUE = 'original'\n")
    (source / 'value.js').write_text("module.exports = 'original';\n")
    sources = {'library': Source(source, ('demo', 'value.js'))}
    return source, sources, GenerationStore(tmp_path / 'cache')


def test_existing_flow_keeps_old_lazy_imports_and_node_children_after_update(tmp_path):
    source, sources, store = fixture(tmp_path)
    old = store.capture(sources)
    store.adopt(old, sources)
    with store.execution(store.current(sources)) as pin:
        (source / 'demo/later.py').write_text("VALUE = 'updated'\n")
        (source / 'value.js').write_text("module.exports = 'updated';\n")
        with pytest.raises(GenerationError, match='run update'):
            store.current(sources)
        new = store.capture(sources)
        store.adopt(new, sources)
        assert store.current(sources) == new and new != old
        tree = store.directory(old) / 'tree/library'
        core = Path(treadway.__file__).resolve().parent.parent
        program = '''
import json,os,subprocess
from treadway.generations import GenerationStore
from pathlib import Path
store=GenerationStore(os.environ['TEST_STORE'])
generation=store.pinned(os.environ['TREADWAY_GENERATION'],os.environ['TREADWAY_EXECUTION'])
from demo.later import VALUE
js=store.directory(generation)/'tree/library/value.js'
node=subprocess.check_output(['node','-e','console.log(require(process.argv[1]))',str(js)],text=True).strip()
print(json.dumps({'python':VALUE,'node':node}))
'''
        result = subprocess.run([sys.executable, '-c', program], capture_output=True, text=True,
                                env={**os.environ, **pin, 'TEST_STORE': str(store.root),
                                     'PYTHONPATH': os.pathsep.join([str(tree), str(core)])}, timeout=10)
        assert result.returncode == 0, result.stderr
        assert json.loads(result.stdout) == {'python': 'original', 'node': 'original'}
    with pytest.raises(GenerationError, match='expired'):
        store.pinned(pin['TREADWAY_GENERATION'], pin['TREADWAY_EXECUTION'])
    assert (store.directory(new) / 'tree/library/demo/later.py').read_text() == "VALUE = 'updated'\n"


def test_missing_source_does_not_adopt_or_fall_back(tmp_path):
    _, sources, store = fixture(tmp_path)
    old = store.capture(sources)
    store.adopt(old, sources)
    missing = {'library': Source(tmp_path / 'missing', ('demo',))}
    with pytest.raises((GenerationError, FileNotFoundError)):
        store.current(missing)
    assert json.loads((store.root / 'current.json').read_text())['generation'] == old


def test_changed_source_cannot_publish_or_adopt_partial_generation(tmp_path, monkeypatch):
    source, sources, store = fixture(tmp_path)
    original_write = Path.write_bytes
    changed = False
    def write(path, content):
        nonlocal changed
        result = original_write(path, content)
        if not changed and '.capture-' in str(path):
            changed = True
            (source / 'value.js').write_text("module.exports = 'changed during copy';\n")
        return result
    monkeypatch.setattr(Path, 'write_bytes', write)
    with pytest.raises(GenerationError, match='changed during capture'):
        store.capture(sources)
    assert not (store.root / 'current.json').exists()
    assert not list((store.root / 'generations').iterdir())


def test_snapshot_mutation_is_detected(tmp_path):
    _, sources, store = fixture(tmp_path)
    generation = store.capture(sources)
    file = store.directory(generation) / 'tree/library/value.js'
    file.chmod(0o600)
    file.write_text('unexpected change')
    with pytest.raises(GenerationError, match='contents differ'):
        store.verify(generation)


def test_unrecorded_bytecode_cannot_override_hashed_source(tmp_path):
    _, sources, store = fixture(tmp_path)
    generation = store.capture(sources)
    original = store.directory(generation) / 'tree/library/demo/later.py'
    replacement = tmp_path / 'replacement.py'
    replacement.write_text("VALUE = 'modified'\n")
    # Match size and mtime so CPython would consider the injected pyc current.
    os.utime(replacement, ns=(original.stat().st_atime_ns, original.stat().st_mtime_ns))
    cache = Path(importlib.util.cache_from_source(str(original)))
    cache.parent.mkdir()
    py_compile.compile(str(replacement), cfile=str(cache), dfile=str(original), doraise=True)
    with pytest.raises(GenerationError, match='bytecode'):
        store.verify(generation)


def test_raw_generation_variable_is_not_an_execution_pin(tmp_path):
    _, sources, store = fixture(tmp_path)
    generation = store.capture(sources)
    with pytest.raises(GenerationError, match='flow-scoped'):
        store.pinned(generation, None)


def test_symlink_source_escape_is_rejected_and_cache_dirs_are_ignored(tmp_path):
    source, sources, _ = fixture(tmp_path)
    before = fingerprint(sources)
    (source / 'demo/node_modules').mkdir()
    (source / 'demo/node_modules/unselected.py').write_text('cache data')
    assert fingerprint(sources) == before
    outside = tmp_path / 'outside'
    outside.mkdir()
    (outside / 'private.txt').write_text('synthetic data outside selected root')
    (source / 'alias').symlink_to(outside, target_is_directory=True)
    with pytest.raises(GenerationError, match='symlinks'):
        fingerprint({'library': Source(source, ('alias/private.txt',))})


def test_store_construction_is_passive_and_bad_paths_are_rejected(tmp_path):
    store = GenerationStore(tmp_path / 'absent')
    assert not store.root.exists()
    with pytest.raises(GenerationError, match='relative'):
        store.capture({'library': Source(tmp_path, ('../outside',))})
