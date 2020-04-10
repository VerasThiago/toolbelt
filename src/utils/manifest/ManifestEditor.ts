import { readJson, writeJson, writeJsonSync } from 'fs-extra'
import { resolve } from 'path'
import { CommandError } from '../errors'
import { getAppRoot } from '../manifest'
import { ManifestValidator } from './ManifestValidator'

export class ManifestEditor {
  public static readonly MANIFEST_FILE_NAME = 'manifest.json'

  public static readonly MANIFEST_SCHEMA =
    'https://raw.githubusercontent.com/vtex/node-vtex-api/master/gen/manifest.schema'

  public static get manifestPath() {
    return resolve(getAppRoot(), this.MANIFEST_FILE_NAME)
  }

  public static async getManifestEditor(path = ManifestEditor.manifestPath) {
    const manifest = new ManifestEditor(path)
    await manifest.init()
    return manifest
  }

  public static async isManifestReadable() {
    try {
      await this.readAndParseManifest(this.manifestPath)
      return true
    } catch (error) {
      return false
    }
  }

  public static readAndParseManifest(path: string) {
    try {
      return readJson(path)
    } catch (e) {
      if (e.code === 'ENOENT') {
        throw new Error(`Missing manifest.json on app root. ${e}`)
      }

      throw new CommandError(`Malformed manifest.json file. ${e}`)
    }
  }

  public manifest: Manifest

  constructor(public path = ManifestEditor.manifestPath) {}

  public async init() {
    this.manifest = await ManifestEditor.readAndParseManifest(this.path)
    ManifestValidator.validate(this.manifest)
  }

  public get name() {
    return this.manifest.name
  }

  public get version() {
    return this.manifest.version
  }

  public get vendor() {
    return this.manifest.vendor
  }

  public get dependencies() {
    return this.manifest.dependencies
  }

  public get builders() {
    return this.manifest.builders
  }

  public get builderNames() {
    return Object.keys(this.manifest.builders)
  }

  public get appLocator() {
    const { vendor, name, version } = this.manifest
    return `${vendor}.${name}@${version}`
  }

  public get majorRange() {
    return `${this.manifest.version.split('.', 2)[0]}.x`
  }

  public flushChangesSync() {
    return writeJsonSync(this.path, this.manifest, { spaces: 2 })
  }

  public flushChanges() {
    return writeJson(this.path, this.manifest, { spaces: 2 })
  }

  public async writeSchema(): Promise<void> {
    if (this.manifest.$schema !== ManifestEditor.MANIFEST_SCHEMA) {
      this.manifest.$schema = ManifestEditor.MANIFEST_SCHEMA
    }

    return this.flushChanges()
  }

  public addDependency(app: string, version: string): Promise<void> {
    this.manifest.dependencies = {
      ...this.manifest.dependencies,
      [app]: version,
    }

    return this.flushChanges()
  }
}
