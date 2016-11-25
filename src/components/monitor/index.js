'use strict';

const defineComponent = require('marko-widgets').defineComponent;
const notis = require('src/components/notis');
const component = {};

component.template = require('./template.marko');

component.init = function() {

    let primus = new Primus('ws://localhost:7777/socket?query=string');
    let container = this.el;

    primus.write('Queued message from browser');

    primus.on('open', spark => {
        console.log('socket open');
        primus.write('Hello from browser!');
    });

    primus.on('error', error => {
        console.error('error received:', error);
    });

    primus.on('data', data => {
        const dataObj = JSON.parse(data);

        if (dataObj.hosts) {
            if (this.getWidget(dataObj.data.id)) {
                this.updateNote(dataObj);
                //console.log('Note exists'); 
            } else {
                this.addNote(dataObj);            
            }
        }
        console.log('data received:', dataObj);
    });

    primus.on('end', () => {
        console.log('connection closed');
    });

    this.el.addEventListener('click', function() {
        console.log('foo');
    });
};

component.getInitialState = function(input) {
    return {
        notes: []
    }
};

component.getTemplateData = function(state, input) {
    return {
        notes: state.notes
    }
}

component.updateNote = function(note) {
    this.getWidget(note.data.id).updateNote(note);
}

component.addNote = function(note) {
    this.state.notes.unshift(note);
    this.setStateDirty('notes');
}

module.exports = defineComponent(component);
