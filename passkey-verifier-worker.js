const { parentPort } = require('node:worker_threads');
const bcrypt = require('bcryptjs');

parentPort.on('message', ({ id, passkey, hashes }) => {
  const matchingIndexes = [];
  const invalidIndexes = [];
  hashes.forEach(({ index, hash }) => {
    try {
      if (bcrypt.compareSync(passkey, hash)) matchingIndexes.push(index);
    } catch (error) {
      invalidIndexes.push(index);
    }
  });
  parentPort.postMessage({ id, matchingIndexes, invalidIndexes });
});
