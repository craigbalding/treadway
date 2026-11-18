'use strict';
// Native same-process recovery. Never discover a replacement or replay a command.
const {parseEndpoint, connectEndpoint} = require('./remote-transport');
const {makeCdpClient} = require('./cdp');
const {ActorBrowser} = require('./actors');
const crypto = require('node:crypto');
const {fail, retain, available, budget, attachExact, verifyPagePrincipal} = require('./reconnect-common');

function validateEndpoint(endpoint) {
  const {parsed} = parseEndpoint(endpoint);
  if ([...parsed.searchParams.keys()].some(key => ['resume', 'profiletoken'].includes(key.toLowerCase())))
    fail('remote_browserserve_endpoint_invalid');
}
function tokenFrom(headers) {
  const token = headers?.['browserserve-resume-token'];
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) fail('remote_browserserve_resume_unavailable');
  return token;
}
function capture(worker, actor, headers) {
  const token = tokenFrom(headers);
  const {endpoint} = parseEndpoint(actor.initialEndpoint);
  // Append without rewriting any opaque proxy/authentication query parameters.
  const separator = endpoint.includes('?') ? (/[?&]$/.test(endpoint) ? '' : '&') : '?';
  const evidence = retain(worker, 'reconnect-native', {version:'treadway.browserserve-resume/1',
    projectId:worker.projectId, runId:worker.runId, actor:actor.name, generation:actor.generation,
    contextId:actor.contextId, targetId:actor.targetId, endpoint:endpoint+separator+'resume='+token});
  const reference = crypto.randomUUID();
  actor.reconnectCapability = {endpoint:endpoint+separator+'resume='+token, token, reference,
    deadline:actor.deadline, usable:true};
  worker.record({kind:'reconnect_prepared', actor:actor.name, generation:actor.generation, reference, evidence});
}
async function disconnect(actor, timeoutMs, {graceful = false} = {}) {
  const socket = actor.ws;
  if (!socket || socket.readyState === socket.CLOSED) return false;
  actor.intentionalClose = socket;
  try {
    return await new Promise(resolve => {
      const finish = value => { clearTimeout(timer); socket.removeListener('close', closed); resolve(value); };
      // A peer may acknowledge with an empty Close frame (reported as 1005).
      // 1006 is transport loss and never proves a completed close handshake.
      const closed = code => {
        if (graceful) actor.providerCloseCode = code;
        finish(graceful ? code === 1000 || code === 1005 : true);
      };
      const timer = setTimeout(() => { socket.terminate(); finish(false); }, timeoutMs);
      socket.once('close', closed);
      if (graceful) socket.close(1000); else socket.terminate();
    });
  } finally { delete actor.intentionalClose; }
}
async function reconnect(worker, actor, {timeoutMs = 10000, principal} = {}) {
  available(actor, {allowUnknownPending:true});
  if (!['ready','transport_lost'].includes(actor.state)) fail('remote_session_unavailable');
  try { new ActorBrowser(null, {...principal, name:actor.name, generation:actor.generation}); }
  catch { fail('remote_reconnect_principal_binding_required'); }
  const capability=actor.reconnectCapability;
  if (!capability?.usable || performance.now() >= actor.deadline) fail('remote_reconnect_capability_unavailable');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs<1 || timeoutMs>60000) fail('remote_reconnect_deadline_invalid');
  actor.state='reconnecting';
  const remaining=budget(actor,timeoutMs);
  worker.record({kind:'reconnect_intent',actor:actor.name,generation:actor.generation,reference:capability.reference});
  let sessionId, opened=false;
  try {
    actor.scopeConfirmed=false;
    const old=actor.ws;
    if (old.readyState !== old.CLOSED && !await disconnect(actor,Math.min(worker.cleanupMs,remaining())))
      fail('remote_reconnect_disconnect_incomplete');
    actor.cdp.close(); actor.attachments.clear();
    capability.usable=false;
    let headers;
    const ws=await connectEndpoint(capability.endpoint,{...actor.transportOptions,fresh:false,
      signal:actor.abort.signal,timeoutMs:remaining(),onUpgrade:value=>{ headers=value; }});
    if(actor.state!=='reconnecting') { ws.terminate(); fail('remote_reconnect_cancelled'); }
    actor.ws=ws; actor.cdp=makeCdpClient(ws,{nextCommandId:actor.nextCommandId}); opened=true; worker.watchTransport(actor,ws);
    if(tokenFrom(headers)!==capability.token) fail('remote_browserserve_resume_binding_differs');
    sessionId=await attachExact(worker,actor,remaining);
    const evidence=await verifyPagePrincipal(worker,actor,sessionId,remaining,principal);
    remaining();
    worker.record({kind:'reconnect_ready',actor:actor.name,generation:actor.generation,reference:capability.reference,evidence});
    capability.usable=true; actor.state='ready';
    return {reconnected:true,generation:actor.generation,principalVerified:true,reconciliationRequired:actor.uncertain};
  } catch(error) {
    // A resume token is reusable across drops. A definite handshake rejection
    // (including not-yet-parked 404) or predispatch failure did not claim it.
    // Keep it for an explicit caller retry; never retry or launch here.
    if (!opened && ['rejected','not_dispatched'].includes(error.allocation)) capability.usable=true;
    worker.record({kind:'reconnect_incomplete',actor:actor.name,generation:actor.generation,reference:capability.reference});
    if(actor.state==='reconnecting') actor.state=opened&&actor.scopeConfirmed?'revalidation_failed':'transport_lost';
    throw error;
  } finally {
    if(sessionId) await worker.detachPage(actor,sessionId);
    if(!actor.scopeConfirmed && opened) {
      await disconnect(actor,worker.cleanupMs,{graceful:true}); actor.cdp?.close();
    }
  }
}
module.exports={validateEndpoint,tokenFrom,capture,reconnect,disconnect};
