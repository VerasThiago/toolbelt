import { flags as oclifFlags } from '@oclif/command'

import workspaceInfo from '../../modules/workspace/info'
import { CustomCommand } from '../../oclif/CustomCommand'

export default class WorkspaceInfo extends CustomCommand {
  static description = 'Display information about the current workspace'

  static aliases = ['workspace']

  static examples = ['vtex workspace info', 'vtex info']

  static flags = {
    help: oclifFlags.help({ char: 'h' }),
  }

  static args = []

  async run() {
    this.parse(WorkspaceInfo)

    await workspaceInfo()
  }
}