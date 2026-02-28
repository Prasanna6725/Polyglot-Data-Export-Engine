class ExportStore {
  constructor() {
    this.exports = new Map();
  }

  set(exportId, exportJob) {
    this.exports.set(exportId, exportJob);
  }

  get(exportId) {
    return this.exports.get(exportId);
  }

  delete(exportId) {
    this.exports.delete(exportId);
  }

  has(exportId) {
    return this.exports.has(exportId);
  }
}

module.exports = { ExportStore };
