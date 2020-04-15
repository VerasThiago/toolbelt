import { flags as oclifFlags } from '@oclif/command'

import workspacePromote from '../../modules/workspace/promote'
import { CustomCommand } from '../../oclif/CustomCommand'

export default class WorkspacePromote extends CustomCommand {
  static description = 'Promote this workspace to master'

  static aliases = ['promote']

  static examples = ['vtex workspace promote', 'vtex promote']

  static flags = {
    help: oclifFlags.help({ char: 'h' }),
  }

  static args = []

  async run() {
    this.parse(WorkspacePromote)

    await workspacePromote()
  }
}
