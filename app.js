const assert = require('assert');
assert.ok(process.env.JAMBONES_MYSQL_HOST &&
  process.env.JAMBONES_MYSQL_USER &&
  process.env.JAMBONES_MYSQL_PASSWORD &&
  process.env.JAMBONES_MYSQL_DATABASE, 'missing JAMBONES_MYSQL_XXX env vars');
assert.ok(process.env.DRACHTIO_PORT || process.env.DRACHTIO_HOST, 'missing DRACHTIO_PORT env var');
assert.ok(process.env.DRACHTIO_SECRET, 'missing DRACHTIO_SECRET env var');
assert.ok(process.env.JAMBONES_TIME_SERIES_HOST, 'missing JAMBONES_TIME_SERIES_HOST env var');
assert.ok(process.env.JAMBONES_NETWORK_CIDR || process.env.K8S, 'missing JAMBONES_NETWORK_CIDR env var');
const Srf = require('drachtio-srf');
const srf = new Srf('sbc-inbound');
const opts = Object.assign({
  timestamp: () => {return `, "time": "${new Date().toISOString()}"`;}
}, {level: process.env.JAMBONES_LOGLEVEL || 'info'});
const logger = require('pino')(opts);
const {
  queryCdrs,
  writeCdrs,
  writeAlerts,
  AlertType
} = require('@jambonz/time-series')(logger, {
  host: process.env.JAMBONES_TIME_SERIES_HOST,
  port: process.env.JAMBONES_TIME_SERIES_PORT || 8086,
  commitSize: 50,
  commitInterval: 'test' === process.env.NODE_ENV ? 7 : 20
});
const StatsCollector = require('@jambonz/stats-collector');
const stats = new StatsCollector(logger);
const {equalsIgnoreOrder, createHealthCheckApp, systemHealth} = require('./lib/utils');
const {LifeCycleEvents} = require('./lib/constants');
const setNameRtp = `${(process.env.JAMBONES_CLUSTER_ID || 'default')}:active-rtp`;
const rtpServers = [];
const setName = `${(process.env.JAMBONES_CLUSTER_ID || 'default')}:active-sip`;

const {
  pool,
  lookupAuthHook,
  lookupSipGatewayBySignalingAddress,
  addSbcAddress,
  lookupAccountByPhoneNumber,
  lookupAppByTeamsTenant,
  lookupAccountBySipRealm,
  lookupAccountBySid,
  lookupAccountCapacitiesBySid
} = require('@jambonz/db-helpers')({
  host: process.env.JAMBONES_MYSQL_HOST,
  user: process.env.JAMBONES_MYSQL_USER,
  password: process.env.JAMBONES_MYSQL_PASSWORD,
  database: process.env.JAMBONES_MYSQL_DATABASE,
  connectionLimit: process.env.JAMBONES_MYSQL_CONNECTION_LIMIT || 10
}, logger);
const {client: redisClient, createSet, retrieveSet, addToSet, removeFromSet, incrKey, decrKey} = require('@jambonz/realtimedb-helpers')({
  host: process.env.JAMBONES_REDIS_HOST || 'localhost',
  port: process.env.JAMBONES_REDIS_PORT || 6379
}, logger);

let srfHealth = true

const {getRtpEngine, setRtpEngines} = require('@jambonz/rtpengine-utils')([], logger, {
  emitter: stats,
  dtmfListenPort: process.env.DTMF_LISTEN_PORT || 22224,
  protocol: 'udp'
});
srf.locals = {...srf.locals,
  stats,
  queryCdrs,
  writeCdrs,
  writeAlerts,
  AlertType,
  activeCallIds: new Map(),
  getRtpEngine,
  dbHelpers: {
    pool,
    lookupAuthHook,
    lookupSipGatewayBySignalingAddress,
    lookupAccountByPhoneNumber,
    lookupAppByTeamsTenant,
    lookupAccountBySid,
    lookupAccountBySipRealm,
    lookupAccountCapacitiesBySid
  },
  realtimeDbHelpers: {
    createSet,
    incrKey,
    decrKey,
    retrieveSet
  }
};
const {
  wasOriginatedFromCarrier,
  getApplicationForDidAndCarrier,
  getOutboundGatewayForRefer
} = require('./lib/db-utils')(srf, logger);
srf.locals = {
  ...srf.locals,
  wasOriginatedFromCarrier,
  getApplicationForDidAndCarrier,
  getOutboundGatewayForRefer,
  getFeatureServer: require('./lib/fs-tracking')(srf, logger)
};
const activeCallIds = srf.locals.activeCallIds;

const {
  initLocals,
  identifyAccount,
  checkLimits,
  challengeDeviceCalls
} = require('./lib/middleware')(srf, logger);
const CallSession = require('./lib/call-session');

if (process.env.DRACHTIO_HOST && !process.env.K8S) {
  const CIDRMatcher = require('cidr-matcher');
  const cidrs = process.env.JAMBONES_NETWORK_CIDR
    .split(',')
    .map((s) => s.trim());
  const matcher = new CIDRMatcher(cidrs);

  srf.connect({host: process.env.DRACHTIO_HOST, port: process.env.DRACHTIO_PORT, secret: process.env.DRACHTIO_SECRET });
  srf.on('connect', (err, hp) => {
    if (err) return this.logger.error({err}, 'Error connecting to drachtio server');
    logger.info(`connected to drachtio listening on ${hp}`);

    const hostports = hp.split(',');
    for (const hp of hostports) {
      const arr = /^(.*)\/(.*):(\d+)$/.exec(hp);
      if (arr && 'udp' === arr[1] && !matcher.contains(arr[2])) {
        logger.info(`adding sbc public address to database: ${arr[2]}`);
        srf.locals.sipAddress = arr[2];
        if (!process.env.SBC_ACCOUNT_SID) addSbcAddress(arr[2]);
      }
      else if (arr && 'tcp' === arr[1] && matcher.contains(arr[2])) {
        const hostport = `${arr[2]}:${arr[3]}`;
        logger.info(`adding sbc private address to redis: ${hostport}`);
        srf.locals.privateSipAddress = hostport;
        srf.locals.addToRedis = () => addToSet(setName, hostport);
        srf.locals.removeFromRedis = () => removeFromSet(setName, hostport);
        srf.locals.addToRedis();
      }
    }
  });
}
else {
  logger.info(`listening in outbound mode on port ${process.env.DRACHTIO_PORT}`);
  srf.listen({port: process.env.DRACHTIO_PORT, secret: process.env.DRACHTIO_SECRET});
}
if (process.env.NODE_ENV === 'test') {
  srf.on('error', (err) => {
    srfHealth = false
    logger.info(err, 'Error connecting to drachtio');
  });
}

/* install middleware */
srf.use('invite', [initLocals, identifyAccount, checkLimits, challengeDeviceCalls]);

srf.invite((req, res) => {
  if (req.has('Replaces')) {
    const arr = /^(.*);from/.exec(req.get('Replaces'));
    if (arr) logger.info(`replacing call-id ${arr}`);
    else logger.info(`failed parsing ${req.get('Replaces')}`);
    const session = arr ? activeCallIds.get(arr[1]) : null;
    if (!session) {
      logger.info(`failed to find session in Replaces header: ${req.has('Replaces')}`);
      return res.send(404);
    }
    return session.replaces(req, res);
  }
  const session = new CallSession(logger, req, res);
  session.connect();
});

srf.use((req, res, next, err) => {
  logger.error(err, 'hit top-level error handler');
  res.send(500);
});

if (process.env.K8S) {
  const PORT = process.env.HTTP_PORT || 3000;
  const getCount = () => activeCallIds.size;
  const healthCheck = require('@jambonz/http-health-check');

  createHealthCheckApp(PORT, logger)
  .then(app => {
    healthCheck({app, logger, path: '/', fn: getCount});
    healthCheck({app, logger, path: '/system-health', fn: systemHealth(redisClient, pool.promise(), activeCallIds.size, srfHealth)});
  })
}
if ('test' !== process.env.NODE_ENV) {
  /* update call stats periodically */
  setInterval(() => {
    stats.gauge('sbc.sip.calls.count', activeCallIds.size, ['direction:inbound']);
  }, 20000);
}

const lookupRtpServiceEndpoints = (lookup, serviceName) => {
  logger.debug(`dns lookup for ${serviceName}..`);
  lookup(serviceName, {family: 4, all: true}, (err, addresses) => {
    if (err) {
      logger.error({err}, `Error looking up ${serviceName}`);
      return;
    }
    logger.debug({addresses, rtpServers}, `dns lookup for ${serviceName} returned`);
    const addrs = addresses.map((a) => a.address);
    if (!equalsIgnoreOrder(addrs, rtpServers)) {
      rtpServers.length = 0;
      Array.prototype.push.apply(rtpServers, addrs);
      logger.info({rtpServers}, 'rtpserver endpoints have been updated');
      setRtpEngines(rtpServers.map((a) => `${a}:${process.env.RTPENGINE_PORT || 22222}`));
    }
  });
};

if (process.env.K8S_RTPENGINE_SERVICE_NAME) {
  /* poll dns for endpoints every so often */
  const arr = /^(.*):(\d+)$/.exec(process.env.K8S_RTPENGINE_SERVICE_NAME);
  const svc = arr[1];
  logger.info(`rtpengine(s) will be found at dns name: ${svc}`);
  const {lookup} = require('dns');
  lookupRtpServiceEndpoints(lookup, svc);
  setInterval(lookupRtpServiceEndpoints.bind(null, lookup, svc), process.env.RTPENGINE_DNS_POLL_INTERVAL || 10000);
}
else if (process.env.JAMBONES_RTPENGINES) {
  /* static list of rtpengines */
  setRtpEngines([process.env.JAMBONES_RTPENGINES]);
}
else {
  /* poll redis periodically for rtpengines that have registered via OPTIONS ping */
  const getActiveRtpServers = async() => {
    try {
      const set = await retrieveSet(setNameRtp);
      const newArray = Array.from(set);
      logger.debug({newArray, rtpServers}, 'getActiveRtpServers');
      if (!equalsIgnoreOrder(newArray, rtpServers)) {
        logger.info({newArray}, 'resetting active rtpengines');
        setRtpEngines(newArray.map((a) => `${a}:${process.env.RTPENGINE_PORT || 22222}`));
        rtpServers.length = 0;
        Array.prototype.push.apply(rtpServers, newArray);
      }
    } catch (err) {
      logger.error({err}, 'Error setting new rtpengines');
    }
  };
  setInterval(() => {
    getActiveRtpServers();
  }, 30000);
  getActiveRtpServers();

}

const {lifecycleEmitter} = require('./lib/autoscale-manager')(logger);

/* if we are scaling in, check every so often if call count has gone to zero */
setInterval(async() => {
  if (lifecycleEmitter.operationalState === LifeCycleEvents.ScaleIn) {
    if (0 === activeCallIds.size) {
      logger.info('scale-in complete now that calls have dried up');
      lifecycleEmitter.scaleIn();
    }
  }
}, 20000);

process.on('SIGUSR2', handle.bind(null, removeFromSet, setName));
process.on('SIGTERM', handle.bind(null, removeFromSet, setName));

function handle(removeFromSet, setName, signal) {
  logger.info(`got signal ${signal}, removing ${srf.locals.privateSipAddress} from set ${setName}`);
  removeFromSet(setName, srf.locals.privateSipAddress);
}

module.exports = {srf, logger};
