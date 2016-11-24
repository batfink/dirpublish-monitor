'use strict';

const defineComponent = require('marko-widgets').defineComponent;

const component = {};

component.template = require('./template.marko');

component.getInitialState = function(input) {
    return {};
}

component.getTemplateData = function(state, input, out) {
    console.log(state, input, out);
    return {
        publication: input.publication,
        event: input.event,
        title: input.title
    }
}

module.exports = defineComponent(component);

