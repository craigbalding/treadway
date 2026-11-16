"""Disposable owner editor for the optimisation walkthrough, never a live target."""
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import socket
import sqlite3
from threading import Thread
from urllib.parse import parse_qs, urlsplit
import uuid

from treadway.diagnostics import current_run
from treadway.recovery import Assessment, AuthenticationOwner, AuthenticationResult, OperationExecutor, RecoveryPolicy
from treadway.sessions import HttpFailure, HttpSession


OWNERS = ['owner-a', 'owner-b']
ACTORS = ['member-a', 'member-b']


def page(kind, item=''):
    common = '<!doctype html><title>Owner editor</title><main id="application">'
    if kind == 'login':
        return common + '''<input id="account"><input id="password" type="password"><button id="login">Sign in</button>
<script>document.querySelector('#login').onclick=async()=>{
const r=await fetch('/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({actor:document.querySelector('#account').value,password:document.querySelector('#password').value})});
if(r.ok)location.href='/items';};</script>'''
    if kind == 'list':
        return common + '''<div id="items"></div><script>
fetch('/items-data').then(r=>r.json()).then(v=>{for(const item of v.items||[]){const a=document.createElement('a');a.id=item.id;a.href='/editor?id='+item.id;a.textContent=item.id;document.querySelector('#items').append(a);}});</script>'''
    return common + '''<p id="actor"></p><form id="editor"><input id="owner"><button id="save" type="submit">Save</button></form><p id="validation"></p><p id="saved"></p>
<script>let binding;const id=''' + json.dumps(item) + ''';
fetch('/items/'+id).then(r=>r.json()).then(v=>{binding=v;document.querySelector('#actor').textContent=v.creator;document.querySelector('#owner').value=v.owner;document.querySelector('#editor').dataset.ready='true';});
document.querySelector('#editor').onsubmit=async e=>{e.preventDefault();const owner=document.querySelector('#owner').value;
if(!['owner-a','owner-b'].includes(owner)){document.querySelector('#validation').textContent='Unknown owner';return;}
const r=await fetch('/items/'+id,{method:'PATCH',headers:{'Content-Type':'application/json','If-Match':String(binding.revision)},body:JSON.stringify({id,owner,revision:binding.revision})});
const value=await r.json();if(r.ok){binding=value;document.querySelector('#saved').textContent='Saved';}else document.querySelector('#validation').textContent=value.error;};</script>'''


class OwnerFixture:
    """Passive construction; start explicitly creates scoped state and loopback HTTP."""
    def __init__(self, root, count=1, *, expire_after=None, lose_response=None):
        self.root, self.count = Path(root), count
        self.expire_after, self.lose_response = expire_after, lose_response
        self.server = None
        self.state = {'writes': 0, 'refreshes': 0, 'attempts': [], 'lost': False, 'contract': 1,
                      'epochs': {actor: 0 for actor in ACTORS}}

    def start(self):
        self.root.mkdir(parents=True, mode=0o700)
        self.database = self.root/'owners.sqlite'
        self.database.touch(mode=0o600)
        with sqlite3.connect(self.database) as db:
            db.execute('CREATE TABLE items (id TEXT PRIMARY KEY, creator TEXT, owner TEXT, revision INTEGER, writes INTEGER)')
            db.execute('CREATE TABLE sessions (token TEXT PRIMARY KEY, actor TEXT, epoch INTEGER)')
            db.execute('CREATE TABLE audit (item TEXT, principal TEXT)')
            db.executemany('INSERT INTO items VALUES (?,?,?,1,0)',
                           [(f'item-{i}', ACTORS[(i-1) % 2], 'owner-a') for i in range(1, self.count+1)])
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def reply(self, status, body, cookies=(), html=False):
                encoded = body.encode() if html else json.dumps(body).encode()
                self.send_response(status)
                self.send_header('Content-Type', 'text/html' if html else 'application/json')
                self.send_header('Content-Length', str(len(encoded)))
                self.send_header('Cache-Control', 'no-store')
                for cookie in cookies:
                    self.send_header('Set-Cookie', cookie)
                self.end_headers()
                self.wfile.write(encoded)

            def cookies(self):
                jar = SimpleCookie()
                jar.load(self.headers.get('Cookie', ''))
                return {key: value.value for key, value in jar.items()}

            def actor(self):
                token = self.cookies().get('session', '')
                with sqlite3.connect(fixture.database) as db:
                    row = db.execute('SELECT actor,epoch FROM sessions WHERE token=?', (token,)).fetchone()
                return row[0] if row and row[1] == fixture.state['epochs'][row[0]] else None

            def body(self):
                size = int(self.headers.get('Content-Length', 0))
                if not 0 < size < 16384:
                    raise ValueError('bounded_fixture_body_required')
                return json.loads(self.rfile.read(size))

            def do_GET(self):
                route = urlsplit(self.path)
                if route.path == '/contract':
                    return self.reply(200, {'version': fixture.state['contract']})
                if route.path == '/login':
                    return self.reply(200, page('login'), html=True)
                actor = self.actor()
                if actor is None:
                    return self.reply(401, {'error': 'session_expired'})
                if route.path == '/principal':
                    return self.reply(200, {'principal': actor})
                if route.path == '/items':
                    return self.reply(200, page('list'), html=True)
                if route.path == '/editor':
                    return self.reply(200, page('editor', parse_qs(route.query)['id'][0]), html=True)
                if route.path == '/items-data':
                    with sqlite3.connect(fixture.database) as db:
                        ids = [row[0] for row in db.execute('SELECT id FROM items WHERE creator=?', (actor,))]
                    return self.reply(200, {'items': [{'id': item} for item in ids]})
                item = fixture.observe(route.path.removeprefix('/items/'))
                if item is None:
                    return self.reply(404, {'error': 'absent'})
                return self.reply(200, item) if item['creator'] == actor else self.reply(403, {'error': 'private_item'})

            def do_POST(self):
                body = self.body()
                if self.path == '/session':
                    actor = body.get('actor')
                    if actor not in ACTORS or body.get('password') != 'synthetic-only':
                        return self.reply(401, {'error': 'credentials_refused'})
                elif self.path == '/refresh':
                    actor = self.cookies().get('refresh')
                    if actor not in ACTORS:
                        return self.reply(401, {'error': 'refresh_refused'})
                    fixture.state['refreshes'] += 1
                else:
                    return self.reply(404, {})
                token = uuid.uuid4().hex
                with sqlite3.connect(fixture.database) as db:
                    db.execute('INSERT INTO sessions VALUES (?,?,?)', (token, actor, fixture.state['epochs'][actor]))
                self.reply(200, {'principal': actor}, [f'session={token}; Path=/; HttpOnly; SameSite=Strict',
                                                      f'refresh={actor}; Path=/refresh; HttpOnly; SameSite=Strict'])

            def do_PATCH(self):
                body, actor = self.body(), self.actor()
                fixture.state['attempts'].append({'actor': actor, 'path': self.path})
                if actor is None:
                    return self.reply(401, {'error': 'session_expired'})
                with sqlite3.connect(fixture.database) as db:
                    db.execute('BEGIN IMMEDIATE')
                    row = db.execute('SELECT creator,owner,revision,writes FROM items WHERE id=?', (body['id'],)).fetchone()
                    if self.path != '/items/'+body['id'] or not row:
                        return self.reply(404, {'error': 'absent'})
                    if row[0] != actor:
                        return self.reply(403, {'error': 'private_item'})
                    if body['revision'] != row[2] or self.headers.get('If-Match') != str(row[2]):
                        return self.reply(409, {'error': 'stale_revision'})
                    if body['owner'] not in OWNERS:
                        return self.reply(400, {'error': 'unknown_owner'})
                    db.execute('UPDATE items SET owner=?,revision=revision+1,writes=writes+1 WHERE id=?', (body['owner'], body['id']))
                    db.execute('INSERT INTO audit VALUES (?,?)', (body['id'], actor))
                fixture.state['writes'] += 1
                if fixture.state['writes'] == fixture.expire_after:
                    fixture.state['epochs'][actor] += 1
                if body['id'] == fixture.lose_response and not fixture.state['lost']:
                    fixture.state['lost'] = True
                    self.connection.shutdown(socket.SHUT_RDWR)
                    self.connection.close()
                    return
                self.reply(200, fixture.observe(body['id']))

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = Thread(target=lambda: self.server.serve_forever(poll_interval=.01), daemon=True)
        self.thread.start()
        self.origin = f'http://127.0.0.1:{self.server.server_port}'
        return self

    def observe(self, item):
        with sqlite3.connect(self.database) as db:
            row = db.execute('SELECT id,creator,owner,revision,writes FROM items WHERE id=?', (item,)).fetchone()
        return dict(zip(('id', 'creator', 'owner', 'revision', 'writes'), row)) if row else None

    def session(self, actor, *, login=True):
        session = HttpSession(actor=actor, origin=self.origin)
        if login:
            response = session.request('/session', method='POST', body={'actor': actor, 'password': 'synthetic-only'})
            if not response.complete or response.status != 200:
                raise AssertionError('fixture_login_incomplete')
        return session

    def mutation_actor(self, item):
        with sqlite3.connect(self.database) as db:
            rows = db.execute('SELECT principal FROM audit WHERE item=?', (item,)).fetchall()
        return rows[0][0] if len(rows) == 1 else None

    def executor(self, actor, root, *, login=True, maintain=True, verify=True, reconcile=True):
        session = self.session(actor, login=login)

        def observe(operation, previous, client):
            actual = self.observe(operation['body']['id'])
            expected = {'id': operation['body']['id'], 'creator': actor, 'owner': operation['body']['owner'],
                        'revision': operation['body']['revision']+1, 'writes': 1}
            return Assessment('confirmed' if actual == expected else 'unknown', evidence={'sqlite': actual})

        def assess(operation, observation, client):
            if isinstance(observation, HttpFailure) or not observation.complete:
                return Assessment('unknown')
            if observation.status in {400, 401, 403, 409}:
                return Assessment('rejected', evidence={'status': observation.status, 'body': observation.json()})
            return observe(operation, None, client)

        def prerequisite(operation):
            observed = HttpSession(actor='contract-observer', origin=self.origin).request('/contract')
            run = current_run()
            if run:
                run.check_contract('owner-api-version', expected=1, observed=observed.json().get('version'))
            elif not observed.complete or observed.json() != {'version': 1}:
                raise ValueError('owner_contract_changed')
            actual = self.observe(operation['body']['id'])
            if actual is None or actual['creator'] != actor or actual['revision'] != operation['body']['revision']:
                raise ValueError('original_resource_binding_differs')

        def renew(client, context):
            response = client.request('/refresh', method='POST', body={'fixture': True})
            return AuthenticationResult('ready' if response.complete and response.status == 200 else 'unknown', 'fixture-refresh')

        owner = AuthenticationOwner(actor, Path(root)/'authentication',
            prepare=lambda client, context: AuthenticationResult('ready', 'fixture-cookie'), renew=renew,
            classify=lambda failure: failure.observation is not None and failure.observation.complete
            and failure.observation.status == 401 and failure.observation.json() == {'error': 'session_expired'})
        return OperationExecutor(session, Path(root)/'operations', probe='/principal', expected={'principal': actor},
            owner=owner, assess=assess, reconcile=observe if reconcile else None, prerequisite=prerequisite,
            policy=RecoveryPolicy(maintain_authentication=maintain, verify_principal=verify, max_renewals=1))

    def close(self):
        if self.server:
            self.server.shutdown()
            self.server.server_close()
            self.thread.join(timeout=2)
            if self.thread.is_alive():
                raise RuntimeError('fixture_cleanup_incomplete')
            self.server = None
