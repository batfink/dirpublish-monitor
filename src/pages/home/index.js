'use strict';

const template = require('./template');

module.exports = (req, res) => {
   res.marko(template, { foo: 'bar' });
}
