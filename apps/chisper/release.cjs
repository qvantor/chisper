// The release of the analytics (src/app/common/services/analytics.ts, inlined by webpack.config.js) and of the
// source maps uploaded for its stacks (scripts/analytics/sourcemaps.mjs): the two must be one. NX_PUBLIC_RELEASE
// where it is set (not empty), else the short sha of the commit Netlify builds (COMMIT_REF); none out of Netlify
exports.releaseOf = (env) => env.NX_PUBLIC_RELEASE || (env.COMMIT_REF ?? '').slice(0, 7);
