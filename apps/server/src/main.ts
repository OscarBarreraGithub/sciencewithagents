// Temporary groups-only distribution. The launcher retains this entry and ownership.
// Full SWA remains available for deliberate recovery and preservation fixtures.
if (process.argv.includes('--full-swa') || process.argv.includes('--demo'))
  await import('./full-main.js');
else await import('./groups-main.js');
export {};
