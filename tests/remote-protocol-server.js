// Standalone form of the deterministic protocol fixture for Python integration.
const {protocolFixture} = require('./remote-protocol-fixture');
const cleanups = [];
protocolFixture({after: cleanup => cleanups.push(cleanup)}, {capacity: process.argv[2] ? Number(process.argv[2]) : Infinity,
  sharedBrowser: ['shared', 'reconnect'].includes(process.argv[3]), reconnectSupport: process.argv[3] === 'reconnect',
  profileSupport: process.argv[3] === 'provider'}).then(fixture => {
  process.stdout.write(JSON.stringify({endpoint: fixture.endpoint, sessionApi: fixture.sessionApi}) + '\n');
  process.stdin.resume();
  process.stdin.on('end', async () => { for (const cleanup of cleanups) await cleanup(); });
}).catch(() => { process.exitCode = 1; });
