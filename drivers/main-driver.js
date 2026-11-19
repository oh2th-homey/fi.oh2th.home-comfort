'use strict';

const { Driver } = require('homey');
const migrate = require('../lib/migrate');

module.exports = class mainDriver extends Driver {
  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log(`${this.id} - onInit`);
  }

  /**
   * @description Pairing view "import" (issue #36, removed after the move #39): this driver's devices from the old app,
   * read from its GET /export once per pairing session. Each driver calls this in onPair.
   */
  setImportHandlers(session) {
    let exported = null;
    const read = async () => {
      if (!exported) exported = await this.readOldExport();
      return exported;
    };
    session.setHandler('get_import', async () => {
      let devices = [];
      try {
        const existing = this.getDevices().map((device) => device.getData().id);
        devices = migrate.importable(await read(), this.id, existing);
      } catch (error) {
        // No old app (or an old version without the export): pairing goes on as usual.
        this.log(`get_import - ${error.message || error}`);
      }
      this.log(`get_import - ${devices.length} to import`);
      return { devices };
    });
    session.setHandler('import_device', async ({ id }) => {
      await this.checkImport();
      const data = await read();
      const device = migrate.device(data, this.id, id, migrate.settingIds(this.manifest.settings));
      await this.onImport(device, data);
      this.log(`import_device - ${device.name} (${device.data.id})`);
      return device;
    });
  }

  /**
   * @description The old app's export; throws when it isn't installed or running.
   */
  async readOldExport() {
    const api = this.homey.api.getApiApp(migrate.OLD_APP);
    if (!(await api.getInstalled())) throw new Error('old app not installed');
    const exported = await api.get('/export');
    migrate.checkExport(exported);
    return exported;
  }

  /**
   * @description What must exist before a device of this driver is imported (as at pairing); override per driver.
   */
  async checkImport() {}

  /**
   * @description Extra work for an imported device before it is created; override per driver.
   */
  async onImport(device, exported) {}
};
