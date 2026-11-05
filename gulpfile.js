const { src, dest } = require('gulp');

function buildIcons() {
  return src(['src/**/*.svg', 'src/**/*.png']).pipe(dest('dist'));
}

function copyJson() {
  return src('src/**/*.node.json').pipe(dest('dist'));
}

exports['build:icons'] = buildIcons;
exports['build:json'] = copyJson;
exports.default = exports['build:icons'];
