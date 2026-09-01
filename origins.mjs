// The only place an origin is written down.
//
// Every hardcoded localhost in this project was a reason it could not be
// deployed, and the worst of them was the coordinator's own address inside
// kit/vendor.mjs: that constant is the exposedTo allowlist, so getting it wrong
// on a real host does not degrade anything, it makes every vendor tool
// unreachable by anything at all.
//
// Deployment rewrites the LIVE table and nothing else.

export const LOCAL = {
  app:    'http://localhost:5173',
  fly:    'http://localhost:5177',
  stay:   'http://localhost:5178',
  visa:   'http://localhost:5179',
  permit: 'http://localhost:5180',
  shady:  'http://localhost:5181',
};

// The deployment. Each participant is its own project, so these are genuinely
// separate origins and the browser boundary between them is real -- which is
// the premise, and would be a lie on one host with five paths.
export const LIVE = {
  app:    'https://concord-coordinator.vercel.app',
  fly:    'https://concord-fly.vercel.app',
  stay:   'https://concord-stay.vercel.app',
  visa:   'https://concord-visa.vercel.app',
  permit: 'https://concord-permit.vercel.app',
  shady:  'https://concord-meridian.vercel.app',
};
