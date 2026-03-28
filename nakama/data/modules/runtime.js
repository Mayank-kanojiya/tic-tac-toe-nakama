console.log('=== main.js loaded ===');
function rpcCreateTttMatch(ctx, logger, nk, payload) {
  var matchId = nk.matchCreate('ttt_match', {});
  return JSON.stringify({ matchId: matchId });
}

function InitModule(ctx, logger, nk, initializer) {
  console.log('=== InitModule called ===');
  initializer.registerRpc('create_ttt_match', rpcCreateTttMatch);
  logger.info('Module loaded: create_ttt_match RPC registered');
  console.log('=== RPC registered ===');
}

global.InitModule = InitModule;
