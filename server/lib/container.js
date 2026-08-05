const { initDatabase, cleanupExpiredState } = require('../db');
const { loadConfig } = require('./config');
const { AuthService } = require('./utils/auth');
const { GuestService } = require('./utils/guest');
const { StorageFactory } = require('./storage/factory');
const { StorageConfigRepository } = require('./repos/storage-config-repo');
const { FileRepository } = require('./repos/file-repo');
const { ApiTokenRepository } = require('./repos/api-token-repo');
const { PasteRepository } = require('./repos/paste-repo');
const { UploadService } = require('./services/upload-service');
const { ChunkUploadService } = require('./services/chunk-service');
const { createSettingsStore } = require('./settings/factory');

function createContainer(env = process.env) {
  const config = loadConfig(env);
  const db = initDatabase(config.dbPath);

  const storageRepo = new StorageConfigRepository(db, config);
  const fileRepo = new FileRepository(db);
  const apiTokenRepo = new ApiTokenRepository(db);
  const pasteRepo = new PasteRepository(db);
  const storageFactory = new StorageFactory();
  const settingsStore = createSettingsStore({ db, config });

  storageRepo.ensureBootstrapStorage();
  cleanupExpiredState(db);

  const uploadService = new UploadService({
    storageRepo,
    fileRepo,
    storageFactory,
  });

  const chunkService = new ChunkUploadService({
    db,
    config,
    uploadService,
  });

  const authService = new AuthService(db, config);
  const guestService = new GuestService(db, config);

  return {
    config,
    db,
    authService,
    guestService,
    storageRepo,
    fileRepo,
    apiTokenRepo,
    pasteRepo,
    storageFactory,
    settingsStore,
    uploadService,
    chunkService,
  };
}

module.exports = {
  createContainer,
};
