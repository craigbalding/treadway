"""Private, synthetic-only JSON transport to the actual Robot Browser library."""
import contextlib
import json
import os
from pathlib import Path
import sys
from importlib.metadata import version

import psutil

from Browser import Browser


def main():
    # Browser's Node subprocess inherits fd 0. Keep the harness protocol on a
    # dedicated descriptor so a child cannot consume it or change its flags.
    protocol = os.fdopen(os.dup(sys.stdin.fileno()))
    with open(os.devnull) as child_stdin:
        os.dup2(child_stdin.fileno(), sys.stdin.fileno())
    browser = None
    for line in protocol:
        request = json.loads(line)
        try:
            with contextlib.redirect_stdout(sys.stderr):
                if browser is None:
                    browser = Browser(jsextension=str(Path(__file__).with_name('extension.cjs')))
                op = request['op']
                data = request.get('data', {})
                if op == 'start':
                    result = browser.new_browser(executablePath=os.environ['CHROME_BIN'],
                                                 chromiumSandbox=True, reuse_existing=False,
                                                 args=['--disable-dev-shm-usage'])
                elif op == 'context':
                    result = browser.new_context(acceptDownloads=False)
                    browser.new_page(data['url'])
                elif op == 'switch':
                    result = browser.switch_context(data['context'])
                elif op == 'attach':
                    browser_id = browser.connect_to_browser(data['endpoint'], use_cdp=True)
                    pages = browser.get_page_ids()
                    matches = []
                    for page_id in pages:
                        browser.switch_page(page_id)
                        target_id = browser.call_js_keyword('perform', operation='cdp-target', payload={})
                        if target_id == data['targetId']:
                            matches.append(page_id)
                    if len(matches) != 1:
                        raise ValueError('one_exact_cdp_target_required')
                    browser.switch_page(matches[0])
                    result = {'browser': browser_id, 'pages': len(pages), 'targetMatches': len(matches), 'targetId': data['targetId']}
                elif op == 'close':
                    browser.close_browser('ALL')
                    result = True
                elif op == 'launch-observation':
                    launches = []
                    for process in psutil.Process().children(recursive=True):
                        try:
                            args = process.cmdline()
                        except psutil.NoSuchProcess:
                            continue
                        profiles = [arg.split('=', 1)[1] for arg in args if arg.startswith('--user-data-dir=')]
                        if profiles and not any(arg.startswith('--type=') for arg in args):
                            launches.append({'pid': process.pid, 'args': args, 'profile': profiles[0],
                                             'profileMode': oct(Path(profiles[0]).stat().st_mode & 0o777)})
                    result = {'launches': launches, 'robot': version('robotframework'),
                              'browser': version('robotframework-browser'), 'python': sys.version.split()[0]}
                else:
                    result = browser.call_js_keyword('perform', operation=op, payload=data)
            response = {'id': request['id'], 'ok': True, 'value': result}
        except Exception as error:
            response = {'id': request['id'], 'ok': False, 'error': str(error)}
        print('@comparison@' + json.dumps(response), flush=True)
        if request['op'] == 'close':
            break


if __name__ == '__main__':
    main()
