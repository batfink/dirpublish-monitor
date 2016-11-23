'use strict';

const defineComponent = require('marko-widgets').defineComponent;

module.exports = defineComponent({
    template: require('./template.marko'),
    init: function() {
        this.el.addEventListener('click', function() {
            console.log('baddaboom');
        });
    },
    getTemplateData: function(state, input, out) {
        return {
            name: 'fyttigrisen'
        }
    }
});

/*let component = {};

component.template = require('./template.marko');

component.init = function() {
    this.el.addEventListener('click', function() {
        console.log('foo');
    });
};

module.exports = defineComponent(component);*/
