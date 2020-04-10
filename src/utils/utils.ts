import axios from 'axios'
import chalk from 'chalk'
import Table from 'cli-table2'
import enquirer from 'enquirer'
import R, {
  compose,
  concat,
  contains,
  curry,
  drop,
  head,
  last,
  prop,
  propSatisfies,
  reduce,
  split,
  tail,
  __,
} from 'ramda'
import semverDiff from 'semver-diff'
import { execSync } from 'child-process-es6-promise'
import { diffArrays } from 'diff'
import { existsSync } from 'fs-extra'
import { resolve as resolvePath } from 'path'

import { dummyLogger } from '../clients/dummyLogger'
import * as conf from './conf'
import * as env from './env'
import envTimeout from './timeout'
import userAgent from './user-agent'
import { promptConfirm } from './prompts'
import { workspaces, createClients, apps } from '../clients'
import { getAppRoot } from './manifest'
import log from './logger'
import { logAll, onEvent } from './sse'
import { BuildFailError, UserCancelledError, CommandError } from './errors'
import { createTable } from './table'
import { ManifestEditor } from './manifest/ManifestEditor'

export const VERBOSE = '--verbose'
export const isVerbose = process.argv.indexOf(VERBOSE) >= 0

interface BuildListeningOptions {
  context?: Context
  timeout?: number
}

type BuildEvent = 'start' | 'success' | 'fail' | 'timeout' | 'logs'
type AnyFunction = (...args: any[]) => any

const allEvents: BuildEvent[] = ['start', 'success', 'fail', 'timeout', 'logs']

const flowEvents: BuildEvent[] = ['start', 'success', 'fail']

export const yarnPath = `"${require.resolve('yarn/bin/yarn')}"`

const DEFAULT_TIMEOUT = 10000

export const IOClientOptions = {
  timeout: (envTimeout || DEFAULT_TIMEOUT) as number,
  retries: 3,
}

export const getIOContext = () => ({
  account: conf.getAccount(),
  authToken: conf.getToken(),
  production: false,
  product: '',
  region: env.region(),
  route: {
    id: '',
    params: {},
  },
  userAgent,
  workspace: conf.getWorkspace(),
  requestId: '',
  operationId: '',
  logger: dummyLogger,
  platform: '',
})

const onBuildEvent = (
  ctx: Context,
  timeout: number,
  appOrKey: string,
  callback: (type: BuildEvent, message?: Message) => void
) => {
  const [subject] = appOrKey.split('@')
  const unlistenLogs = logAll(ctx, log.level, subject)
  const [unlistenStart, unlistenSuccess, unlistenFail] = flowEvents.map(type =>
    onEvent(ctx, 'vtex.render-builder', subject, [`build.${type}`], message => callback(type, message))
  )
  const timer = timeout && setTimeout(() => callback('timeout'), timeout)
  const unlistenMap: Record<BuildEvent, AnyFunction> = {
    fail: unlistenFail,
    logs: unlistenLogs,
    start: unlistenStart,
    success: unlistenSuccess,
    timeout: () => clearTimeout(timer),
  }

  return (...types: BuildEvent[]) => {
    types.forEach(type => {
      unlistenMap[type]()
    })
  }
}

export const listenBuild = (
  appOrKey: string,
  triggerBuild: (unlistenBuild?: (response) => void) => Promise<any>,
  options: BuildListeningOptions = {}
) => {
  return new Promise((resolve, reject) => {
    let triggerResponse

    const { context = conf.currentContext, timeout = 5000 } = options
    const unlisten = onBuildEvent(context, timeout, appOrKey, (eventType, message) => {
      switch (eventType) {
        case 'start':
          unlisten('start', 'timeout')
          break
        case 'success':
        case 'timeout':
          unlisten(...allEvents)
          resolve(triggerResponse)
          break
        case 'fail':
          unlisten(...allEvents)
          reject(new BuildFailError(message))
          break
      }
    })

    const unlistenBuild = response => {
      unlisten(...allEvents)
      resolve(response)
    }

    triggerBuild(unlistenBuild)
      .then(response => {
        triggerResponse = response
      })
      .catch(e => {
        unlisten(...allEvents)
        reject(e)
      })
  })
}

export const formatNano = (nanoseconds: number): string =>
  `${(nanoseconds / 1e9).toFixed(0)}s ${((nanoseconds / 1e6) % 1e3).toFixed(0)}ms`

export const runYarn = (relativePath: string, force: boolean) => {
  log.info(`Running yarn in ${chalk.green(relativePath)}`)
  const root = getAppRoot()
  const command = force
    ? `${yarnPath} --force --non-interactive --ignore-engines`
    : `${yarnPath} --non-interactive --ignore-engines`
  execSync(command, { stdio: 'inherit', cwd: resolvePath(root, relativePath) })
  log.info('Finished running yarn')
}

export const runYarnIfPathExists = (relativePath: string) => {
  const root = getAppRoot()
  const pathName = resolvePath(root, relativePath)
  if (existsSync(pathName)) {
    try {
      runYarn(relativePath, false)
    } catch (e) {
      log.error(`Failed to run yarn in ${chalk.green(relativePath)}`)
      throw e
    }
  }
}

const getSwitchAccountMessage = (previousAccount: string, currentAccount = conf.getAccount()): string => {
  return `Now you are logged in ${chalk.blue(currentAccount)}. Do you want to return to ${chalk.blue(
    previousAccount
  )} account?`
}

export const switchToPreviousAccount = async (previousConf: any) => {
  const previousAccount = previousConf.account
  if (previousAccount !== conf.getAccount()) {
    const canSwitchToPrevious = await promptConfirm(getSwitchAccountMessage(previousAccount))
    if (canSwitchToPrevious) {
      conf.saveAll(previousConf)
    }
  }
}

const formatAppId = (appId: string) => {
  const [appVendor, appName] = R.split('.', appId)
  if (!appName) {
    // Then the app is an 'infra' app.
    const [infraAppVendor, infraAppName] = R.split(':', appId)
    if (!infraAppName) {
      return appId
    }
    return `${chalk.blue(infraAppVendor)}:${infraAppName}`
  }
  return `${chalk.blue(appVendor)}.${appName}`
}

const cleanVersion = (appId: string) => {
  return R.compose<string, string[], string, string>(
    (version: string) => {
      const [pureVersion, build] = R.split('+build', version)
      return build ? `${pureVersion}(linked)` : pureVersion
    },
    R.last,
    R.split('@')
  )(appId)
}

export const matchedDepsDiffTable = (title1: string, title2: string, deps1: string[], deps2: string[]) => {
  const depsDiff = diffArrays(deps1, deps2)
  // Get deduplicated names (no version) of the changed deps.
  const depNames = [
    ...new Set(
      R.compose<string[], any[], string[], string[], string[]>(
        R.map(k => R.head(R.split('@', k))),
        R.flatten,
        R.pluck('value'),
        R.filter((k: any) => Boolean(k.removed) || Boolean(k.added))
      )(depsDiff)
    ),
  ].sort((strA, strB) => strA.localeCompare(strB))
  const produceStartValues = () => R.map(_ => [])(depNames) as any
  // Each of the following objects will start as a { `depName`: [] }, ... }-like.
  const addedDeps = R.zipObj(depNames, produceStartValues())
  const removedDeps = R.zipObj(depNames, produceStartValues())

  // Custom function to set the objects values.
  const setObjectValues = (obj, formatter, filterFunction) => {
    R.compose<void, any[], any[], any[], any[]>(
      // eslint-disable-next-line array-callback-return
      R.map(k => {
        const index = R.head(R.split('@', k))
        obj[index].push(formatter(k))
      }),
      R.flatten,
      R.pluck('value'),
      R.filter(filterFunction)
    )(depsDiff)
    R.mapObjIndexed((_, index) => {
      obj[index] = obj[index].join(',')
    })(obj)
  }

  // Setting the objects values.
  setObjectValues(
    removedDeps,
    k => chalk.red(`${cleanVersion(k)}`),
    (k: any) => Boolean(k.removed)
  )
  setObjectValues(
    addedDeps,
    k => chalk.green(`${cleanVersion(k)}`),
    (k: any) => Boolean(k.added)
  )

  const table = createTable() // Set table headers.
  table.push(['', chalk.bold.yellow(title1), chalk.bold.yellow(title2)])

  const formattedDepNames = R.map(formatAppId, depNames)
  // Push array of changed dependencies pairs to the table.
  Array.prototype.push.apply(
    table,
    R.map((k: any[]) => R.flatten(k))(
      R.zip(
        // zipping 3 arrays.
        R.zip(formattedDepNames, R.values(removedDeps)),
        R.values(addedDeps)
      )
    )
  )
  return table
}

export function truncateStringsFromObject(element: any, maxStrSize: number) {
  if (element === null || element === undefined) {
    return element
  }
  if (typeof element === 'object') {
    Object.keys(element).forEach(key => {
      element[key] = truncateStringsFromObject(element[key], maxStrSize)
    })
    return element
  }
  if (typeof element === 'string' && element.length > maxStrSize) {
    return `${element.substr(0, maxStrSize)}[...TRUNCATED]`
  }
  return element
}

export function hrTimeToMs(hrtime: [number, number]) {
  return 1e3 * hrtime[0] + hrtime[1] / 1e6
}

const workspaceExampleName = process.env.USER || 'example'

const workspaceMasterAllowedOperations = ['install', 'uninstall']

// It is not allowed to link apps in a production workspace.
const workspaceProductionAllowedOperatios = ['install', 'uninstall']

const builderHubMessagesLinkTimeout = 2000 // 2 seconds
const builderHubMessagesPublishTimeout = 10000 // 10 seconds

export const workspaceMasterMessage = `This action is ${chalk.red('not allowed')} in workspace ${chalk.green(
  'master'
)}, please use another workspace.
You can run "${chalk.blue(`vtex use ${workspaceExampleName} -r`)}" to use a workspace named "${chalk.green(
  workspaceExampleName
)}"`

export const workspaceProductionMessage = workspace =>
  `This action is ${chalk.red('not allowed')} in workspace ${chalk.green(
    workspace
  )} because it is a production workspace. You can create a ${chalk.yellowBright('dev')} workspace called ${chalk.green(
    workspaceExampleName
  )} by running ${chalk.blue(`vtex use ${workspaceExampleName} -r`)}`

export const parseArgs = (args: string[]): string[] => {
  return drop(1, args)
}

export const promptWorkspaceMaster = async account => {
  const confirm = await promptConfirm(
    `Are you sure you want to force this operation on the ${chalk.green(
      'master'
    )} workspace on the account ${chalk.blue(account)}?`,
    false
  )
  if (!confirm) {
    throw new UserCancelledError()
  }
  log.warn(`Using ${chalk.green('master')} workspace. I hope you know what you're doing. 💥`)
}

export const validateAppAction = async (operation: string, app?) => {
  const account = conf.getAccount()
  const workspace = conf.getWorkspace()

  if (workspace === 'master') {
    if (!contains(operation, workspaceMasterAllowedOperations)) {
      throw new CommandError(workspaceMasterMessage)
    } else {
      await promptWorkspaceMaster(account)
    }
  }

  const workspaceMeta = await workspaces.get(account, workspace)
  if (workspaceMeta.production && !contains(operation, workspaceProductionAllowedOperatios)) {
    throw new CommandError(workspaceProductionMessage(workspace))
  }

  // No app arguments and no manifest file.
  const isReadable = await ManifestEditor.isManifestReadable()
  if (!app && !isReadable) {
    throw new CommandError(
      `No app was found, please fix your manifest.json${app ? ' or use <vendor>.<name>[@<version>]' : ''}`
    )
  }
}

export const wildVersionByMajor = compose<string, string[], string, string>(concat(__, '.x'), head, split('.'))

export const extractVersionFromId = compose<string, string[], string>(last, split('@'))

export const pickLatestVersion = (versions: string[]): string => {
  const start = head(versions)
  return reduce(
    (acc: string, version: string) => {
      return semverDiff(acc, version) ? version : acc
    },
    start,
    tail(versions)
  )
}

export const handleError = curry((app: string, err: any) => {
  if (err.response && err.response.status === 404) {
    return Promise.reject(new CommandError(`App ${chalk.green(app)} not found`))
  }
  return Promise.reject(err)
})

export const appLatestVersion = (app: string, version = 'x'): Promise<string | never> => {
  return createClients()
    .registry.getAppManifest(app, version)
    .then<string>(prop('id'))
    .then<string>(extractVersionFromId)
    .catch(handleError(app))
}

export const appLatestMajor = (app: string): Promise<string | never> => {
  return appLatestVersion(app).then<string>(wildVersionByMajor)
}

export const appIdFromRegistry = (app: string, majorLocator: string) => {
  return createClients()
    .registry.getAppManifest(app, majorLocator)
    .then<string>(prop('id'))
    .catch(handleError(app))
}

export function optionsFormatter(billingOptions: BillingOptions) {
  /** TODO: Eliminate the need for this stray, single `cli-table2` dependency */
  const table = new Table({
    head: [{ content: chalk.cyan.bold('Billing Options'), colSpan: 2, hAlign: 'center' }],
    chars: { 'top-mid': '─', 'bottom-mid': '─', 'mid-mid': '─', middle: ' ' },
  })

  if (billingOptions.free) {
    table.push([{ content: chalk.green('This app is free'), colSpan: 2, hAlign: 'center' }])
  } else {
    table.push([
      { content: 'Plan', hAlign: 'center' },
      { content: 'Values', hAlign: 'center' },
    ])

    billingOptions.policies.forEach(policy => {
      let rowCount = 0
      const itemsArray = []

      policy.billing.items.forEach(i => {
        if (i.fixed) {
          itemsArray.push([{ content: `${i.fixed} ${i.itemCurrency}`, hAlign: 'center', vAlign: 'center' }])
          rowCount++
        } else if (i.calculatedByMetricUnit) {
          if (i.calculatedByMetricUnit.minChargeValue) {
            itemsArray.push([`Minimum charge: ${i.calculatedByMetricUnit.minChargeValue} ${i.itemCurrency}`])
            rowCount++
          }

          let rangesStr = ''
          i.calculatedByMetricUnit.ranges.forEach(r => {
            if (r.inclusiveTo) {
              rangesStr += `${r.multiplier} ${i.itemCurrency}/${i.calculatedByMetricUnit.metricName} (${r.exclusiveFrom} to ${r.inclusiveTo})`
              rangesStr += '\nor\n'
            } else {
              rangesStr += `${r.multiplier} ${i.itemCurrency}/${i.calculatedByMetricUnit.metricName} (over ${r.exclusiveFrom})`
            }
          })

          rowCount++
          itemsArray.push([{ content: rangesStr, hAlign: 'center', vAlign: 'center' }])
        }
        itemsArray.push([{ content: '+', hAlign: 'center' }])
        rowCount++
      })

      itemsArray.pop()
      rowCount--

      table.push(
        [
          {
            content: `${chalk.yellow(policy.plan)}\n(Charged montlhy)`,
            rowSpan: rowCount,
            colSpan: 1,
            vAlign: 'center',
            hAlign: 'center',
          },
          itemsArray[0][0],
        ],
        ...itemsArray.slice(1)
      )
      table.push([
        {
          content: `The monthly amount will be charged in ${chalk.red(policy.currency)}`,
          colSpan: 2,
          hAlign: 'center',
        },
      ])
    })
  }
  table.push([
    { content: chalk.bold('Terms of use:'), hAlign: 'center' },
    { content: billingOptions.termsURL, hAlign: 'center' },
  ])
  return table.toString()
}

export async function checkBuilderHubMessage(cliRoute: string): Promise<any> {
  const http = axios.create({
    baseURL: 'https://vtex.myvtex.com',
    timeout: cliRoute === 'link' ? builderHubMessagesLinkTimeout : builderHubMessagesPublishTimeout,
  })
  try {
    const res = await http.get(`/_v/private/builder/0/getmessage/${cliRoute}`)
    return res.data
  } catch (e) {
    return {}
  }
}

const promptConfirmName = (msg: string): Promise<string> =>
  enquirer
    .prompt({
      message: msg,
      name: 'appName',
      type: 'input',
    })
    .then<string>(prop('appName'))

export async function showBuilderHubMessage(message: string, showPrompt: boolean, manifest: ManifestEditor) {
  if (message) {
    if (showPrompt) {
      const confirmMsg = `Are you absolutely sure?\n${message ||
        ''}\nPlease type in the name of the app to confirm (ex: vtex.getting-started):`
      const appNameInput = await promptConfirmName(confirmMsg)
      const AppName = `${manifest.vendor}.${manifest.name}`
      if (appNameInput !== AppName) {
        throw new CommandError(`${appNameInput} doesn't match with the app name.`)
      }
    } else {
      log.info(message)
    }
  }
}

export const switchAccountMessage = (previousAccount: string, currentAccount: string): string => {
  return `Now you are logged in ${chalk.blue(currentAccount)}. Do you want to return to ${chalk.blue(
    previousAccount
  )} account?`
}

export const resolveAppId = (appName: string, appVersion: string): Promise<string> =>
  apps.getApp(`${appName}@${appVersion}`).then(prop('id'))

export const isLinked = propSatisfies<string, Manifest>(contains('+build'), 'version')
