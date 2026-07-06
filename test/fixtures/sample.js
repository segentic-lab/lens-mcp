const fs = require('fs');
const path = require('path');

// NOTE: legacy module, consider migrating to TS
class FileProcessor {
  constructor(basePath) {
    this.basePath = basePath;
  }

  /* BUG: doesn't handle symlinks */
  process(filename) {
    return path.join(this.basePath, filename);
  }
}

function readConfig(configPath) {
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

// FIXME: add error handling
const transform = (data) => {
  return data.filter(Boolean);
};

module.exports = { FileProcessor, readConfig, transform };
