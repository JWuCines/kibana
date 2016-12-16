import _ from 'lodash';
import Promise from 'bluebird';
import elasticsearch from 'elasticsearch';
import migrateConfig from './migrate_config';
import createKibanaIndex from './create_kibana_index';
import checkEsVersion from './check_es_version';
import kibanaVersion from './kibana_version';
import checkForTribe from './check_for_tribe';

const NoConnections = elasticsearch.errors.NoConnections;
import util from 'util';
const format = util.format;

const NO_INDEX = 'no_index';
const INITIALIZING = 'initializing';
const READY = 'ready';

module.exports = function (plugin, server) {
  const config = server.config();
  const callAdminAsKibanaUser = server.plugins.elasticsearch.getCluster('admin').callWithInternalUser;
  const callDataAsKibanaUser = server.plugins.elasticsearch.getCluster('data').callWithInternalUser;
  const REQUEST_DELAY = config.get('elasticsearch.healthCheck.delay');

  plugin.status.yellow('Waiting for Elasticsearch');
  function waitForPong(callWithInternalUser, url) {
    return callWithInternalUser('ping').catch(function (err) {
      if (!(err instanceof NoConnections)) throw err;
      plugin.status.red(format('Unable to connect to Elasticsearch at %s.', url));

      return Promise.delay(REQUEST_DELAY).then(waitForPong.bind(null, callWithInternalUser, url));
    });
  }

  // just figure out the current "health" of the es setup
  function getHealth() {
    return callAdminAsKibanaUser('cluster.health', {
      timeout: '5s', // tells es to not sit around and wait forever
      index: config.get('kibana.index'),
      ignore: [408]
    })
    .then(function (resp) {
      // if "timed_out" === true then elasticsearch could not
      // find any idices matching our filter within 5 seconds
      if (!resp || resp.timed_out) {
        return NO_INDEX;
      }

      // If status === "red" that means that index(es) were found
      // but the shards are not ready for queries
      if (resp.status === 'red') {
        return INITIALIZING;
      }

      return READY;
    });
  }

  function waitUntilReady() {
    return getHealth()
    .then(function (health) {
      if (health !== READY) {
        return Promise.delay(REQUEST_DELAY).then(waitUntilReady);
      }
    });
  }

  function waitForShards() {
    return getHealth()
    .then(function (health) {
      if (health === NO_INDEX) {
        plugin.status.yellow('No existing Kibana index found');
        return createKibanaIndex(server);
      }

      if (health === INITIALIZING) {
        plugin.status.red('Elasticsearch is still initializing the kibana index.');
        return Promise.delay(REQUEST_DELAY).then(waitForShards);
      }
    });
  }

  function waitForEsVersion() {
    return checkEsVersion(server, kibanaVersion.get()).catch(err => {
      plugin.status.red(err);
      return Promise.delay(REQUEST_DELAY).then(waitForEsVersion);
    });
  }

  function setGreenStatus() {
    return plugin.status.green('Kibana index ready');
  }

  function check() {
    const healthChecks = [
      waitForPong(callAdminAsKibanaUser, config.get('elasticsearch.url'))
      .then(waitForEsVersion)
      .then(checkForTribe.bind(this, callAdminAsKibanaUser))
      .then(waitForShards)
      .then(_.partial(migrateConfig, server))
    ];

    const tribeUrl = config.get('elasticsearch.tribe.url');
    if (tribeUrl) {
      healthChecks.push(
        waitForPong(callDataAsKibanaUser, tribeUrl)
        .then(() => checkEsVersion(server, kibanaVersion.get(), callDataAsKibanaUser))
      );
    }

    return Promise.all(healthChecks)
    .then(setGreenStatus)
    .catch(err => plugin.status.red(err));
  }


  let timeoutId = null;

  function scheduleCheck(ms) {
    if (timeoutId) return;

    const myId = setTimeout(function () {
      check().finally(function () {
        if (timeoutId === myId) startorRestartChecking();
      });
    }, ms);

    timeoutId = myId;
  }

  function startorRestartChecking() {
    scheduleCheck(stopChecking() ? REQUEST_DELAY : 1);
  }

  function stopChecking() {
    if (!timeoutId) return false;
    clearTimeout(timeoutId);
    timeoutId = null;
    return true;
  }

  return {
    waitUntilReady: waitUntilReady,
    run: check,
    start: startorRestartChecking,
    stop: stopChecking,
    isRunning: function () { return !!timeoutId; },
  };

};
