import { readdir, readJson, remove, writeJson, ensureDir, ensureFile, move } from 'fs-extra'
import { randomBytes } from 'crypto'
import { isArray } from 'util'
import * as lockfile from 'lockfile'
import { join, basename } from 'path'

import { TelemetryClient } from '../../clients/telemetryClient'
import { region } from '../../env'
import userAgent from '../../user-agent'
import { createIOContext, createTelemetryClient } from '../clients'
import { SessionManager } from '../session/SessionManager'
import { TelemetryLocalStore } from './TelemetryStore'
import { ErrorReport } from '../error/ErrorReport'
import { TelemetryCollector } from './TelemetryCollector'
import { ErrorCodes } from '../error/ErrorCodes'

class FileLock {
  public readonly lockName: string
  constructor(private lockPath: string, private options: any) {
    this.lockName = basename(lockPath)
  }

  public async lock() {
    await ensureDir(TelemetryReporter.PENDING_DATA_DIR)
    return new Promise((resolve, reject) => {
      lockfile.lock(this.lockPath, this.options, err => {
        err ? reject(err) : resolve()
      })
    })
  }

  public unlock() {
    try {
      lockfile.unlock(this.lockPath)
    } catch (err) {
      return null
    }
  }
}

export class TelemetryReporter {
  private static readonly RETRIES = 3
  private static readonly TIMEOUT = 30 * 1000
  public static readonly PENDING_DATA_DIR = join(TelemetryCollector.TELEMETRY_LOCAL_DIR, 'pendingData')
  public static getTelemetryReporter() {
    const { account, workspace, token } = SessionManager.getSessionManager()
    const telemetryClient = createTelemetryClient(
      createIOContext({
        account,
        workspace,
        authToken: token,
        userAgent,
        region: region(),
      }),
      { retries: TelemetryReporter.RETRIES, timeout: TelemetryReporter.TIMEOUT }
    )

    return new TelemetryReporter(telemetryClient, TelemetryReporter.PENDING_DATA_DIR)
  }

  private dataPendingLock: FileLock
  constructor(private telemetryClient: TelemetryClient, private pendingDataDir: string) {
    const dataPendingLockName = 'reporter.lock'
    const dataPendingLockPath = join(TelemetryReporter.PENDING_DATA_DIR, dataPendingLockName)
    this.dataPendingLock = new FileLock(dataPendingLockPath, {})
  }

  public async reportTelemetryFile(telemetryObjFilePath: string) {
    // Send general toolbelt telemetry
    try {
      const telemetryObj = await readJson(telemetryObjFilePath)
      await this.reportErrors(telemetryObj.errors)
      await remove(telemetryObjFilePath)
    } catch (err) {
      await this.dataPendingLock.lock()
      await move(telemetryObjFilePath, TelemetryReporter.PENDING_DATA_DIR)
      await this.createTelemetryReporterMetaError(err)
      this.dataPendingLock.unlock()
    }
  }

  public async sendPendingData() {
    // Send pending data
    await this.dataPendingLock.lock()

    const pendingDataFiles = await this.pendingFilesPaths()
    const errors = []
    await Promise.all(
      pendingDataFiles.map(async pendingDataFile => {
        try {
          const pendingDataObject = await readJson(pendingDataFile)
          await this.reportErrors(pendingDataObject)
          await remove(pendingDataFile)
        } catch (err) {
          errors.push(err)
        }
      })
    )

    await this.createTelemetryReporterMetaError(errors)
    this.dataPendingLock.unlock()
  }

  public reportErrors(errors: any[]) {
    return this.telemetryClient.reportErrors(errors)
  }

  public async createTelemetryReporterMetaError(errors: any) {
    const errorArray = isArray(errors) ? errors : [errors]
    const metaErrorFilePath = join(this.pendingDataDir, `${randomBytes(8).toString('hex')}.json`)
    const errorsReport = errorArray.map(error => {
      if (!(error instanceof ErrorReport)) {
        return ErrorReport.create({
          code: ErrorCodes.TELEMETRY_REPORTER_ERROR,
          message: errors.message,
          originalError: errors,
          tryToParseError: true,
        })
      }
      return error
    })
    await ensureFile(metaErrorFilePath)
    await writeJson(metaErrorFilePath, { errors: errorsReport })
  }

  private async pendingFilesPaths() {
    const pendingDataFiles = (await readdir(TelemetryReporter.PENDING_DATA_DIR)).filter(fileName => {
      return fileName !== this.dataPendingLock.lockName
    })

    return pendingDataFiles.map(pendingDataFile => join(TelemetryReporter.PENDING_DATA_DIR, pendingDataFile))
  }
}

const start = async () => {
  const store = new TelemetryLocalStore(process.argv[2])
  const telemetryObjFilePath = process.argv[3]
  const reporter = TelemetryReporter.getTelemetryReporter()

  await reporter.reportTelemetryFile(telemetryObjFilePath)

  store.setLastRemoteFlush(Date.now())
  process.exit()
}

if (require.main === module) {
  start()
}
