/** Message types shared by the FEA client and its module worker. */

export const FeaMessage = {
  loaded: 'loaded',
  loadError: 'load-error',
  configure: 'configure',
  capabilities: 'capabilities',
  solve: 'solve',
  progress: 'progress',
  cancel: 'cancel',
  dispose: 'dispose',
};
