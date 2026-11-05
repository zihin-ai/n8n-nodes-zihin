const { src, dest } = require('gulp');

function buildIcons() {
  return src(['nodes/**/*.{svg,png}', 'credentials/**/*.{svg,png}'], { base: '.' }).pipe(dest('dist'));
}

function copyJson() {
  return src('nodes/**/*.node.json', { base: '.' }).pipe(dest('dist'));
}

exports['build:icons'] = buildIcons;
exports['build:json'] = copyJson;
exports.default = exports['build:icons'];
