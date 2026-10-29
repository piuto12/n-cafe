const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const MAX_WORKERS = 4;
const MAX_QUEUED_JOBS = 128;
const workerCount = Math.max(
  1,
  Math.min(MAX_WORKERS, os.availableParallelism ? os.availableParallelism() : os.cpus().length)
);
const workers = [];
const queuedJobs = [];
let poolStarted = false;
let nextJobId = 0;

function dispatchJobs() {
  for (const slot of workers) {
    if (!slot.worker || slot.job || queuedJobs.length === 0) continue;

    const job = queuedJobs.shift();
    slot.job = job;
    try {
      slot.worker.postMessage({ id: job.id, passkey: job.passkey, hashes: job.hashes });
    } catch (error) {
      slot.job = null;
      job.reject(error);
    }
  }
}

function startWorker(slot) {
  const worker = new Worker(path.join(__dirname, 'passkey-verifier-worker.js'));
  slot.worker = worker;

  worker.on('message', result => {
    const job = slot.job;
    slot.job = null;
    if (!job || result.id !== job.id) {
      console.error('Passkey verification worker returned an unexpected result.');
      if (job) job.reject(new Error('Passkey verification worker returned an invalid result.'));
    } else if (result.error) {
      job.reject(new Error(result.error));
    } else {
      job.resolve(result);
    }
    dispatchJobs();
  });

  worker.on('error', error => {
    console.error('Passkey verification worker failed:', error);
    slot.worker = null;
    if (slot.job) {
      slot.job.reject(error);
      slot.job = null;
    }
  });

  worker.on('exit', code => {
    if (slot.job) {
      slot.job.reject(new Error(`Passkey verification worker exited with code ${code}.`));
      slot.job = null;
    }
    slot.worker = null;
    if (code !== 0) {
      console.error(`Passkey verification worker exited with code ${code}; restarting it.`);
    }
    try {
      startWorker(slot);
      dispatchJobs();
    } catch (error) {
      console.error('Unable to restart passkey verification worker:', error);
    }
  });
}

function startPool() {
  if (poolStarted) return;
  poolStarted = true;
  for (let i = 0; i < workerCount; i += 1) {
    const slot = { worker: null, job: null };
    workers.push(slot);
    startWorker(slot);
  }
}

function enqueueJob(passkey, hashes) {
  if (queuedJobs.length >= MAX_QUEUED_JOBS) {
    const error = new Error('Bill search is busy. Please try again shortly.');
    error.statusCode = 503;
    return Promise.reject(error);
  }

  return new Promise((resolve, reject) => {
    queuedJobs.push({ id: ++nextJobId, passkey, hashes, resolve, reject });
    dispatchJobs();
  });
}

async function verifyPasskeys(passkey, hashes) {
  if (hashes.length === 0) return { matchingIndexes: [], invalidCount: 0 };
  startPool();

  const groupSize = Math.ceil(hashes.length / workerCount);
  const groups = [];
  for (let start = 0; start < hashes.length; start += groupSize) {
    groups.push(hashes.slice(start, start + groupSize).map((hash, offset) => ({
      index: start + offset,
      hash
    })));
  }

  const results = await Promise.all(groups.map(group => enqueueJob(passkey, group)));
  return {
    matchingIndexes: results.flatMap(result => result.matchingIndexes).sort((a, b) => a - b),
    invalidCount: results.reduce((total, result) => total + result.invalidIndexes.length, 0)
  };
}

module.exports = verifyPasskeys;
