/** Message types shared by the FEA client and its module worker. */

export const FeaMessage = {
  loaded: 'loaded',
  loadError: 'load-error',
  capabilities: 'capabilities',
  solve: 'solve',
  cancel: 'cancel',
  dispose: 'dispose',
};
