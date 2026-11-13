"""Content-addressed source snapshots and process-scoped execution pins.

Source selection is explicit. Capturing and adopting are local filesystem
operations; importing this module or constructing a store starts no work.
"""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import uuid


IGNORED = frozenset({'.git', '__pycache__', 'node_modules', '.venv', 'venv', 'artifacts'})


@dataclass(frozen=True)
class Source:
    root: Path
    include: tuple[str, ...]


class GenerationError(RuntimeError):
    pass


def _relative(value):
    path = Path(value)
    if path.is_absolute() or not path.parts or any(part in {'.', '..'} for part in path.parts):
        raise GenerationError('Explicit relative source paths required')
    return path


def _source_files(source):
    root = Path(source.root).resolve(strict=True)
    seen = set()
    for selected in source.include:
        relative = _relative(selected)
        selected_path = root / relative
        if any((root / Path(*relative.parts[:index])).is_symlink()
               for index in range(1, len(relative.parts) + 1)):
            raise GenerationError('Selected source paths cannot traverse symlinks')
        if not selected_path.exists():
            raise GenerationError(f'Source unavailable: {selected_path}')
        pending = [selected_path]
        while pending:
            path = pending.pop()
            rel = path.relative_to(root)
            if any(part in IGNORED for part in rel.parts) or path.suffix == '.pyc':
                continue
            if path.is_symlink():
                raise GenerationError(f'Source symlink requires an explicit source binding: {path}')
            if path.is_dir():
                pending.extend(sorted(path.iterdir(), reverse=True))
            elif path.is_file() and rel not in seen:
                seen.add(rel)
                yield rel.as_posix(), path
            elif not path.is_file():
                raise GenerationError(f'Source must contain regular files: {path}')


def read_sources(sources):
    """Read only the selected trees; dependency/cache directories are excluded."""
    contents = {}
    for label, source in sorted(sources.items()):
        if not re.fullmatch(r'[a-z][a-z0-9_-]*', label):
            raise GenerationError('Source labels must be simple names')
        for relative, path in sorted(_source_files(source)):
            content = path.read_bytes()
            executable = bool(path.stat().st_mode & 0o111)
            contents[f'{label}/{relative}'] = (content, executable)
    if not contents:
        raise GenerationError('At least one source file is required')
    return contents


def _inventory(contents):
    return {name: {'sha256': hashlib.sha256(content).hexdigest(), 'executable': executable}
            for name, (content, executable) in sorted(contents.items())}


def _identity(inventory):
    return hashlib.sha256(json.dumps(inventory, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def fingerprint(sources):
    return _identity(_inventory(read_sources(sources)))


def _write_json(path, value):
    temporary = path.with_name('.' + path.name + '-' + uuid.uuid4().hex)
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, 'w') as stream:
            json.dump(value, stream, sort_keys=True)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _process(pid):
    """Linux process birth and parent identity; a PID alone is not an owner."""
    try:
        fields = Path(f'/proc/{pid}/stat').read_text().rsplit(') ', 1)[1].split()
        return fields[19], int(fields[1])
    except (OSError, IndexError, ValueError) as error:
        raise GenerationError('Execution owner is no longer available') from error


class GenerationStore:
    def __init__(self, root):
        self.root = Path(root).absolute()

    def directory(self, generation):
        if not isinstance(generation, str) or not re.fullmatch(r'[0-9a-f]{64}', generation):
            raise GenerationError('Invalid generation identity')
        return self.root / 'generations' / generation

    def capture(self, sources):
        """Publish a complete snapshot, refusing source edits during the copy."""
        contents = read_sources(sources)
        inventory = _inventory(contents)
        generation = _identity(inventory)
        parent = self.root / 'generations'
        parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        destination = self.directory(generation)
        if destination.exists():
            self.verify(generation)
            if fingerprint(sources) != generation:
                raise GenerationError('Source changed during capture; no generation adopted')
            return generation
        staging = Path(tempfile.mkdtemp(prefix='.capture-', dir=parent))
        try:
            for name, (content, executable) in contents.items():
                path = staging / 'tree' / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content)
                path.chmod(0o555 if executable else 0o444)
            _write_json(staging / 'manifest.json', {
                'schema': 1, 'generation': generation, 'files': inventory,
                'sources': {label: {'root': str(Path(source.root).resolve()), 'include': list(source.include)}
                            for label, source in sources.items()}})
            if fingerprint(sources) != generation:
                raise GenerationError('Source changed during capture; no generation adopted')
            try:
                staging.rename(destination)
            except OSError:
                if not destination.exists():
                    raise
                self.verify(generation)
            return generation
        finally:
            if staging.exists():
                shutil.rmtree(staging)

    def verify(self, generation):
        directory = self.directory(generation)
        try:
            manifest = json.loads((directory / 'manifest.json').read_text())
            if manifest.get('schema') != 1 or manifest.get('generation') != generation:
                raise GenerationError('Generation manifest identity differs')
            expected = manifest['files']
            actual = {}
            tree = directory / 'tree'
            # Source capture excludes local caches. A published tree must never
            # gain bytecode: Python may execute it instead of the hashed source.
            pending = [tree]
            while pending:
                entry = pending.pop()
                for child in entry.iterdir():
                    if child.name == 'node_modules':
                        continue  # Separately provisioned, locked dependencies.
                    if child.name == '__pycache__' or child.suffix == '.pyc':
                        raise GenerationError('Unrecorded Python bytecode in generation')
                    if child.is_dir() and not child.is_symlink():
                        pending.append(child)
            for label in sorted(tree.iterdir()):
                if not label.is_dir() or label.is_symlink():
                    raise GenerationError('Invalid generation source tree')
                source = Source(tree, (label.name,))
                for name, path in _source_files(source):
                    actual[name] = {'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                                    'executable': bool(path.stat().st_mode & 0o111)}
            if actual != expected or _identity(actual) != generation:
                raise GenerationError('Generation contents differ from their recorded identity')
            return manifest
        except (OSError, ValueError, KeyError, TypeError) as error:
            raise GenerationError(f'Generation unavailable or incomplete: {generation}') from error

    def adopt(self, generation, sources):
        self.verify(generation)
        if fingerprint(sources) != generation:
            raise GenerationError('Source changed before adoption; run update')
        _write_json(self.root / 'current.json', {'generation': generation})

    def current(self, sources):
        try:
            generation = json.loads((self.root / 'current.json').read_text())['generation']
        except (OSError, ValueError, KeyError, TypeError) as error:
            raise GenerationError('No adopted development generation; run setup/update') from error
        self.verify(generation)
        if fingerprint(sources) != generation:
            raise GenerationError('Development source changed; run update before starting new work')
        return generation

    @contextmanager
    def execution(self, generation):
        """Scope a pin to this owner and its descendants, never an entire shell."""
        self.verify(generation)
        operations = self.root / 'operations'
        operations.mkdir(parents=True, exist_ok=True, mode=0o700)
        execution = uuid.uuid4().hex
        path = operations / (execution + '.json')
        pid = os.getpid()
        birth, _ = _process(pid)
        _write_json(path, {'generation': generation, 'owner': pid, 'birth': birth})
        try:
            yield {'TREADWAY_GENERATION': generation, 'TREADWAY_EXECUTION': execution,
                   'PYTHONDONTWRITEBYTECODE': '1',
                   'PYTHONPYCACHEPREFIX': str(operations / (execution + '-bytecode'))}
        finally:
            path.unlink(missing_ok=True)

    def pinned(self, generation, execution):
        if not isinstance(execution, str) or not re.fullmatch(r'[0-9a-f]{32}', execution):
            raise GenerationError('A flow-scoped execution pin is required')
        try:
            record = json.loads((self.root / 'operations' / (execution + '.json')).read_text())
            owner = record['owner']
            if type(owner) is not int or owner <= 0 or record['generation'] != generation:
                raise GenerationError('Execution pin differs from its generation')
            if _process(owner)[0] != record['birth']:
                raise GenerationError('Execution owner identity changed')
            current = os.getpid()
            seen = set()
            while current not in seen and current > 0:
                seen.add(current)
                if current == owner:
                    self.verify(generation)
                    return generation
                _, current = _process(current)
            raise GenerationError('Execution pin belongs to another process tree')
        except (OSError, ValueError, KeyError, TypeError) as error:
            raise GenerationError('Execution pin expired or is unavailable; start a new flow') from error
