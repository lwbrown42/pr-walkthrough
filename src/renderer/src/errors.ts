export function friendlyError(error: { message: string; reason?: string }): string {
  switch (error.reason) {
    case 'no_api_key':
      return 'No API key set — add your Anthropic API key in Settings.'
    case 'max_turns':
    case 'max_budget':
      return `The generation hit its ${error.reason === 'max_turns' ? 'turn' : 'budget'} cap. You can raise the cap in Settings.`
    default:
      return error.message
  }
}
