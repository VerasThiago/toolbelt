import Configstore from 'configstore'
import { name as pkgName } from '../../../package.json'
import { join } from 'path'
import { PathConstants } from '../constants/PathConstants'

export abstract class SessionsPersisterBase {
  public abstract clearData(): void

  public abstract getAccount(): string
  public abstract saveAccount(account: string): void

  public abstract getWorkspace(): string
  public abstract saveWorkspace(workspace: string): void

  public abstract getToken(): string
  public abstract saveToken(token: string): void

  public abstract getLogin(): string
  public abstract saveLogin(login: string): void

  public abstract getAccountToken(account: string): string
  public abstract saveAccountToken(account: string, token: string)
}

export class SessionsPersister extends SessionsPersisterBase {
  private static readonly SESSION_STORE_PATH = join(PathConstants.SESSION_FOLDER, 'session.json')
  private static readonly TOKEN_CACHE_STORE_PATH = join(PathConstants.SESSION_FOLDER, 'tokens.json')
  private static readonly WORKSPACE_METADATA_STORE_PATH = join(PathConstants.SESSION_FOLDER, 'workspace.json')

  public static getSingleton() {
    return new SessionsPersister()
  }

  private oldConfigstore: Configstore
  private tokenCacheStore: Configstore
  private sessionStore: Configstore
  private workspaceMetadataStore: Configstore

  constructor() {
    super()
    this.oldConfigstore = new Configstore(pkgName)
    this.tokenCacheStore = new Configstore('', null, { configPath: SessionsPersister.TOKEN_CACHE_STORE_PATH })
    this.workspaceMetadataStore = new Configstore('', null, {
      configPath: SessionsPersister.WORKSPACE_METADATA_STORE_PATH,
    })
    this.sessionStore = new Configstore('', null, { configPath: SessionsPersister.SESSION_STORE_PATH })
  }

  public clearData() {
    this.oldConfigstore.clear()
    this.tokenCacheStore.clear()
    this.workspaceMetadataStore.clear()
    this.sessionStore.clear()
  }

  public getAccount() {
    return this.sessionStore.get('account')
  }

  public saveAccount(account: string) {
    this.oldConfigstore.set('account', account)
    this.sessionStore.set('account', account)
  }

  public getWorkspace() {
    return this.workspaceMetadataStore.get('current.workspace')
  }

  public saveWorkspace(workspace: string) {
    this.oldConfigstore.set('workspace', workspace)
    this.workspaceMetadataStore.set('current.workspace', workspace)
  }

  public getToken() {
    return this.sessionStore.get('token')
  }

  public saveToken(token: string) {
    this.oldConfigstore.set('token', token)
    this.sessionStore.set('token', token)
  }

  public getLogin() {
    return this.sessionStore.get('login')
  }

  public saveLogin(login: string) {
    this.oldConfigstore.set('login', login)
    this.sessionStore.set('login', login)
  }

  public getAccountToken(account: string) {
    const tokens = this.tokenCacheStore.get('tokens') || {}
    return tokens[account]
  }

  public saveAccountToken(account: string, token: string) {
    this.tokenCacheStore.set(account, token)
  }
}
