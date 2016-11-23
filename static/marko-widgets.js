$_mod.main("/marko-widgets$6.4.1", "lib/index");
$_mod.remap("/marko-widgets$6.4.1/lib/index", "/marko-widgets$6.4.1/lib/index-browser");
$_mod.remap("/marko-widgets$6.4.1/lib/init-widgets", "/marko-widgets$6.4.1/lib/init-widgets-browser");
$_mod.def("/marko-widgets$6.4.1/lib/addEventListener", function(require, exports, module, __filename, __dirname) { /*
 * Copyright 2011 eBay Software Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * This module provides a cross-browser solution for adding event listeners
 * to DOM elements. This code is used to handle the differences between
 * IE and standards browsers. Older IE browsers use "attachEvent" while
 * newer browsers using "addEventListener".
 */
var testEl = document.body || document.createElement('div');

function IEListenerHandle(el, eventType, listener) {
    this._info = [el, eventType, listener];
}

IEListenerHandle.prototype = {
    remove: function() {
        var info = this._info;
        var el = info[0];
        var eventType = info[1];
        var listener = info[2];
        el.detachEvent(eventType, listener);
    }
};


function ListenerHandle(el, eventType, listener) {
    this._info = [el, eventType, listener];
}

ListenerHandle.prototype = {
    remove: function() {
        var info = this._info;
        var el = info[0];
        var eventType = info[1];
        var listener = info[2];
        el.removeEventListener(eventType, listener);
    }
};

/**
 * Adapt an native IE event to a new event by monkey patching it
 */
function getIEEvent() {
    var event = window.event;
    // add event.target
    event.target = event.target || event.srcElement;

    event.preventDefault = event.preventDefault || function() {
        event.returnValue = false;
    };

    event.stopPropagation = event.stopPropagation || function() {
        event.cancelBubble = true;
    };

	event.key = (event.which + 1 || event.keyCode + 1) - 1 || 0;

    return event;
}

if (!testEl.addEventListener) {
    // IE8...
    module.exports = function(el, eventType, listener) {
        function wrappedListener() {
            var event = getIEEvent();
            listener(event);
        }

        eventType = 'on' + eventType;

        el.attachEvent(eventType, wrappedListener);
        return new IEListenerHandle(el, eventType, wrappedListener);
    };
} else {
    // Non-IE8...
    module.exports = function(el, eventType, listener) {
        el.addEventListener(eventType, listener, false);
        return new ListenerHandle(el, eventType, listener);
    };
}

});
$_mod.remap("/marko-widgets$6.4.1/lib/defineWidget", "/marko-widgets$6.4.1/lib/defineWidget-browser");
$_mod.main("/marko-widgets$6.4.1/lib", "");
$_mod.def("/marko-widgets$6.4.1/lib/update-manager", function(require, exports, module, __filename, __dirname) { var process=require("process"); /*
 * Copyright 2011 eBay Software Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var AsyncValue = require('/raptor-async$1.1.3/AsyncValue'/*'raptor-async/AsyncValue'*/);

var afterUpdateAsyncValue = null;
var afterUpdateAsyncValue = null;
var updatesScheduled = false;

var batchStack = []; // A stack of batched updates
var unbatchedQueue = []; // Used for scheduled batched updates

/**
 * This function is called when we schedule the update of "unbatched"
 * updates to widgets.
 */
function updateUnbatchedWidgets() {
    if (!unbatchedQueue.length) {
        // No widgets to update
        return;
    }

    try {
        updateWidgets(unbatchedQueue);
    } finally {
        // Reset the flag now that this scheduled batch update
        // is complete so that we can later schedule another
        // batched update if needed
        updatesScheduled = false;
    }
}

function scheduleUpdates() {
    if (updatesScheduled) {
        // We have already scheduled a batched update for the
        // process.nextTick so nothing to do
        return;
    }

    updatesScheduled = true;

    process.nextTick(updateUnbatchedWidgets);
}

function onAfterUpdate(callback) {
    scheduleUpdates();

    if (!afterUpdateAsyncValue) {
        afterUpdateAsyncValue = new AsyncValue();
    }

    afterUpdateAsyncValue.done(callback);
}

function updateWidgets(queue) {
    // Loop over the widgets in the queue and update them.
    // NOTE: Is it okay if the queue grows during the iteration
    //       since we will still get to them at the end
    for (var i=0; i<queue.length; i++) {
        var widget = queue[i];
        widget.__updateQueued = false; // Reset the "__updateQueued" flag
        widget.update(); // Do the actual widget update
    }

    // Clear out the queue by setting the length to zero
    queue.length = 0;
}

function batchUpdate(func) {
    // If the batched update stack is empty then this
    // is the outer batched update. After the outer
    // batched update completes we invoke the "afterUpdate"
    // event listeners.
    var isOuter = batchStack.length === 0;

    var batch = {
        queue: null
    };

    batchStack.push(batch);

    try {
        func();
    } finally {
        try {
            // Update all of the widgets that where queued up
            // in this batch (if any)
            if (batch.queue) {
                updateWidgets(batch.queue);
            }
        } finally {
            // Now that we have completed the update of all the widgets
            // in this batch we need to remove it off the top of the stack
            batchStack.length--;

            if (isOuter) {
                // If there were any listeners for the "afterUpdate" event
                // then notify those listeners now
                if (afterUpdateAsyncValue) {
                    afterUpdateAsyncValue.resolve();
                    afterUpdateAsyncValue = null;
                }
            }
        }
    }
}

function queueWidgetUpdate(widget) {
    if (widget.__updateQueued) {
        // The widget has already been queued up for an update. Once
        // the widget has actually been updated we will reset the
        // "__updateQueued" flag so that it can be queued up again.
        // Since the widget has already been queued up there is nothing
        // that needs to be done.
        return;
    }

    widget.__updateQueued = true;

    var batchStackLen = batchStack.length;

    if (batchStackLen) {
        // When a batch update is started we push a new batch on to a stack.
        // If the stack has a non-zero length then we know that a batch has
        // been started so we can just queue the widget on the top batch. When
        // the batch is ended this widget will be updated.
        var batch = batchStack[batchStackLen-1];

        // We default the batch queue to null to avoid creating an Array instance
        // unnecessarily. If it is null then we create a new Array, otherwise
        // we push it onto the existing Array queue
        if (batch.queue) {
            batch.queue.push(widget);
        } else {
            batch.queue = [widget];
        }
    } else {
        // We are not within a batched update. We need to schedule a batch update
        // for the process.nextTick (if that hasn't been done already) and we will
        // add the widget to the unbatched queued
        scheduleUpdates();
        unbatchedQueue.push(widget);
    }
}

exports.queueWidgetUpdate = queueWidgetUpdate;
exports.batchUpdate = batchUpdate;
exports.onAfterUpdate = onAfterUpdate;
});
$_mod.def("/marko-widgets$6.4.1/lib/repeated-id", function(require, exports, module, __filename, __dirname) { /*
 * Copyright 2011 eBay Software Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

function RepeatedId() {
    this.nextIdLookup = {};
}

RepeatedId.prototype = {
    nextId: function(parentId, id) {
        var indexLookupKey = parentId + '-' + id;
        var currentIndex = this.nextIdLookup[indexLookupKey];
        if (currentIndex == null) {
            currentIndex = this.nextIdLookup[indexLookupKey] = 0;
        } else {
            currentIndex = ++this.nextIdLookup[indexLookupKey];
        }

        return indexLookupKey.slice(0, -2) + '[' + currentIndex + ']';
    }
};

exports.nextId = function(out, parentId, id) {
    var repeatedId = out.global.__repeatedId;
    if (repeatedId == null) {
        repeatedId = out.global.__repeatedId = new RepeatedId();
    }

    return repeatedId.nextId(parentId, id);
};

});
$_mod.def("/marko-widgets$6.4.1/lib/WidgetDef", function(require, exports, module, __filename, __dirname) { /*
 * Copyright 2011 eBay Software Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

require('/raptor-polyfill$1.0.2/string/endsWith'/*'raptor-polyfill/string/endsWith'*/);

var repeatedId = require('/marko-widgets$6.4.1/lib/repeated-id'/*'../lib/repeated-id'*/);

/**
 * A WidgetDef is used to hold the metadata collected at runtime for
 * a single widget and this information is used to instantiate the widget
 * later (after the rendered HTML has been added to the DOM)
 */
function WidgetDef(config, endFunc, out) {
    this.type = config.type; // The widget module type name that is passed to the factory
    this.id = config.id; // The unique ID of the widget
    this.config = config.config; // Widget config object (may be null)
    this.state = config.state; // Widget state object (may be null)
    this.scope = config.scope; // The ID of the widget that this widget is scoped within
    this.domEvents = null; // An array of DOM events that need to be added (in sets of three)
    this.customEvents = config.customEvents; // An array containing information about custom events
    this.bodyElId = config.bodyElId; // The ID for the default body element (if any any)
    this.children = []; // An array of nested WidgetDef instances
    this.end = endFunc; // A function that when called will pop this widget def off the stack
    this.extend = config.extend; // Information about other widgets that extend this widget.
    this.out = out; // The AsyncWriter that this widget is associated with
    this.hasDomEvents = config.hasDomEvents; // A flag to indicate if this widget has any
                                             // listeners for non-bubbling DOM events
    this._nextId = 0; // The unique integer to use for the next scoped ID
}

WidgetDef.prototype = {
    /**
     * Register a nested widget for this widget. We maintain a tree of widgets
     * so that we can instantiate nested widgets before their parents.
     */
    addChild: function (widgetDef) {
        this.children.push(widgetDef);
    },
    /**
     * This helper method generates a unique and fully qualified DOM element ID
     * that is unique within the scope of the current widget. This method prefixes
     * the the nestedId with the ID of the current widget. If nestedId ends
     * with `[]` then it is treated as a repeated ID and we will generate
     * an ID with the current index for the current nestedId.
     * (e.g. "myParentId-foo[0]", "myParentId-foo[1]", etc.)
     */
    elId: function (nestedId) {
        if (nestedId == null) {
            return this.id;
        } else {
            if (typeof nestedId === 'string' && nestedId.endsWith('[]')) {
                return repeatedId.nextId(this.out, this.id, nestedId);
            } else {
                return this.id + '-' + nestedId;
            }
        }
    },
    /**
     * Registers a DOM event for a nested HTML element associated with the
     * widget. This is only done for non-bubbling events that require
     * direct event listeners to be added.
     * @param  {String} type The DOM event type ("mouseover", "mousemove", etc.)
     * @param  {String} targetMethod The name of the method to invoke on the scoped widget
     * @param  {String} elId The DOM element ID of the DOM element that the event listener needs to be added too
     */
    addDomEvent: function(type, targetMethod, elId) {

        if (!targetMethod) {
            // The event handler method is allowed to be conditional. At render time if the target
            // method is null then we do not attach any direct event listeners.
            return;
        }

        if (!this.domEvents) {
            this.domEvents = [];
        }
        this.domEvents.push(type);
        this.domEvents.push(targetMethod);
        this.domEvents.push(elId);
    },
    /**
     * Returns a string representation of the DOM events data.
     */
    getDomEventsAttr: function() {
        if (this.domEvents) {
            return this.domEvents.join(',');
        }
    },
    /**
     * Returns the next auto generated unique ID for a nested DOM element or nested DOM widget
     */
    nextId: function() {
        return this.id + '-w' + (this._nextId++);
    }
};

module.exports = WidgetDef;
});
$_mod.remap("/marko-widgets$6.4.1/lib/uniqueId", "/marko-widgets$6.4.1/lib/uniqueId-browser");
$_mod.def("/marko-widgets$6.4.1/lib/uniqueId-browser", function(require, exports, module, __filename, __dirname) { /*
 * Copyright 2011 eBay Software Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
var uniqueId = window.MARKO_WIDGETS_UNIQUE_ID;
if (!uniqueId) {
    var _nextUniqueId = 0;
    window.MARKO_WIDGETS_UNIQUE_ID = uniqueId = function() {
        return 'wc' + (_nextUniqueId++);
    };
}

module.exports = uniqueId;
});
$_mod.def("/marko-widgets$6.4.1/lib/WidgetsContext", function(require, exports, module, __filename, __dirname) { /*
 * Copyright 2011 eBay Software Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var WidgetDef = require('/marko-widgets$6.4.1/lib/WidgetDef'/*'./WidgetDef'*/);
var uniqueId = require('/marko-widgets$6.4.1/lib/uniqueId-browser'/*'./uniqueId'*/);
var initWidgets = require('/marko-widgets$6.4.1/lib/init-widgets-browser'/*'./init-widgets'*/);
var EventEmitter = require('/events$1.1.1/events'/*'events'*/).EventEmitter;
var inherit = require('/raptor-util$2.0.0/inherit'/*'raptor-util/inherit'*/);

var PRESERVE_EL = 1;
var PRESERVE_EL_BODY = 2;
var PRESERVE_EL_UNPRESERVED_BODY = 4;

function WidgetsContext(out) {
    EventEmitter.call(this);
    this.out = out;
    this.widgets = [];
    this.widgetStack = [];
    this.preserved = null;
    this.reusableWidgets = null;
    this.reusableWidgetsById = null;
    this.widgetsById = {};
}

WidgetsContext.prototype = {
    getWidgets: function () {
        return this.widgets;
    },

    getWidgetStack: function() {
        return this.widgetStack;
    },

    getCurrentWidget: function() {
        return this.widgetStack.length ? this.widgetStack[this.widgetStack.length - 1] : undefined;
    },

    beginWidget: function (widgetInfo, callback) {
        var _this = this;
        var widgetStack = _this.widgetStack;
        var origLength = widgetStack.length;
        var parent = origLength ? widgetStack[origLength - 1] : null;

        if (!widgetInfo.id) {
            widgetInfo.id = _this._nextWidgetId();
        }

        widgetInfo.parent = parent;

        function end() {
            widgetStack.length = origLength;
        }

        var widgetDef = new WidgetDef(widgetInfo, end, this.out);
        this.widgetsById[widgetInfo.id] = widgetDef;

        if (parent) {
            //Check if it is a top-level widget
            parent.addChild(widgetDef);
        } else {
            _this.widgets.push(widgetDef);
        }
        widgetStack.push(widgetDef);

        this.emit('beginWidget', widgetDef);

        return widgetDef;
    },
    getWidget: function(id) {
        return this.widgetsById[id];
    },
    hasWidgets: function () {
        return this.widgets.length !== 0;
    },
    clearWidgets: function () {
        this.widgets = [];
        this.widgetStack = [];
    },
    _nextWidgetId: function () {
        return uniqueId(this.out);
    },
    initWidgets: function (document) {
        var widgetDefs = this.widgets;
        initWidgets.initClientRendered(widgetDefs, document);
        this.clearWidgets();
    },
    onBeginWidget: function(listener) {
        this.on('beginWidget', listener);
    },

    isPreservedEl: function(id) {
        var preserved = this.preserved;
        return preserved && (preserved[id] & PRESERVE_EL);
    },

    isPreservedBodyEl: function(id) {
        var preserved = this.preserved;
        return preserved && (preserved[id] & PRESERVE_EL_BODY);
    },

    hasUnpreservedBody: function(id) {
        var preserved = this.preserved;
        return preserved && (preserved[id] & PRESERVE_EL_UNPRESERVED_BODY);
    },

    addPreservedDOMNode: function(existingEl, bodyOnly, hasUnppreservedBody) {
        var preserved = this.preserved || (this.preserved = {});

        var value = bodyOnly ?
            PRESERVE_EL_BODY :
            PRESERVE_EL;

        if (hasUnppreservedBody) {
            value |= PRESERVE_EL_UNPRESERVED_BODY;
        }

        preserved[existingEl.id] = value;
    }
};

inherit(WidgetsContext, EventEmitter);

WidgetsContext.getWidgetsContext = function (out) {
    var global = out.global;

    return out.data.widgets ||
        global.widgets ||
        (global.widgets = new WidgetsContext(out));
};


module.exports = WidgetsContext;
});
$_mod.def("/marko-widgets$6.4.1/lib/defineRenderer", function(require, exports, module, __filename, __dirname) { /*
 * Copyright 2011 eBay Software Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var marko = require('/marko$3.12.1/runtime/marko-runtime'/*'marko'*/);
var raptorRenderer = require('/raptor-renderer$1.4.6/lib/raptor-renderer'/*'raptor-renderer'*/);
var extend = require('/raptor-util$2.0.0/extend'/*'raptor-util/extend'*/);

module.exports = function defineRenderer(def) {
    var template = def.template;
    var getInitialProps = def.getInitialProps;
    var getTemplateData = def.getTemplateData;
    var getInitialState = def.getInitialState;
    var getWidgetConfig = def.getWidgetConfig;
    var getInitialBody = def.getInitialBody;
    var extendWidget = def.extendWidget;
    var renderer = def.renderer;

    var loadedTemplate;


    if (!renderer) {
        // Create a renderer function that takes care of translating
        // the input properties to a view state. Also, this renderer
        // takes care of re-using existing widgets.
        renderer = function renderer(input, out) {
            var global = out.global;

            var newProps = input;

            if (!newProps) {
                // Make sure we always have a non-null input object
                newProps = {};
            }

            if (!loadedTemplate) {
                // Lazily load the template on first render to avoid potential problems
                // with circular dependencies
                loadedTemplate = template.render ? template : marko.load(template);
            }

            var widgetState;

            if (getInitialState) {
                // This is a state-ful widget. If this is a rerender then the "input"
                // will be the new state. If we have state then we should use the input
                // as the widget state and skip the steps of converting the input
                // to a widget state.

                if (global.__rerenderWidget && global.__rerenderState) {
                    var isFirstWidget = !global.__firstWidgetFound;

                    if (!isFirstWidget || extendWidget) {
                        // We are the not first top-level widget or we are being extended
                        // so use the merged rerender state as defaults for the input
                        // and use that to rebuild the new state. This is kind of a hack
                        // but extending widgets requires this hack since there is no
                        // single state since the widget state is split between the
                        // widget being extended and the widget doing the extending.
                        for (var k in global.__rerenderState) {
                            if (global.__rerenderState.hasOwnProperty(k) && !input.hasOwnProperty(k)) {
                                newProps[k] = global.__rerenderState[k];
                            }
                        }
                    } else {
                        // We are the first widget and we are not being extended
                        // and we are not extending so use the input as the state
                        widgetState = input;
                        newProps = null;
                    }
                }
            }

            if (!widgetState) {
                // If we do not have state then we need to go through the process
                // of converting the input to a widget state, or simply normalizing
                // the input using getInitialProps

                if (getInitialProps) {
                    // This optional method is used to normalize input state
                    newProps = getInitialProps(newProps, out) || {};
                }

                if (getInitialState) {
                    // This optional method is used to derive the widget state
                    // from the input properties
                    widgetState = getInitialState(newProps, out);
                }
            }

            global.__firstWidgetFound = true;

            // Use getTemplateData(state, props, out) to get the template
            // data. If that method is not provided then just use the
            // the state (if provided) or the input data.
            var templateData = getTemplateData ?
                getTemplateData(widgetState, newProps, out) :
                widgetState || newProps;

            if (templateData) {
                // We are going to be modifying the template data so we need to
                // make a shallow clone of the object so that we don't
                // mutate user provided data.
                templateData = extend({}, templateData);
            } else {
                // We always should have some template data
                templateData = {};
            }

            if (widgetState) {
                // If we have widget state then pass it to the template
                // so that it is available to the widget tag
                templateData.widgetState = widgetState;
            }

            if (newProps) {
                // If we have widget props then pass it to the template
                // so that it is available to the widget tag. The widget props
                // are only needed so that we can call widget.shouldUpdate(newProps)
                templateData.widgetProps = newProps;

                if (getInitialBody) {
                    // If we have widget a widget body then pass it to the template
                    // so that it is available to the widget tag and can be inserted
                    // at the w-body marker
                    templateData.widgetBody = getInitialBody(newProps, out);
                } else {
                    // Default to using the nested content as the widget body
                    // getInitialBody was not implemented
                    templateData.widgetBody = newProps.renderBody;
                }

                if (getWidgetConfig) {
                    // If getWidgetConfig() was implemented then use that to
                    // get the widget config. The widget config will be passed
                    // to the widget constructor. If rendered on the server the
                    // widget config will be serialized to a JSON-like data
                    // structure and stored in a "data-w-config" attribute.
                    templateData.widgetConfig = getWidgetConfig(newProps, out);
                }
            }

            // Render the template associated with the component using the final template
            // data that we constructed
            loadedTemplate.render(templateData, out);
        };
    }

    renderer.render = raptorRenderer.createRenderFunc(renderer);

    return renderer;
};


});
$_mod.def("/marko-widgets$6.4.1/lib/defineComponent", function(require, exports, module, __filename, __dirname) { /*
 * Copyright 2011 eBay Software Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Define a new UI component that includes widget and renderer.
 *
 * @param  {Object} def The definition of the UI component (widget methods, widget constructor, rendering methods, etc.)
 * @return {Widget} The resulting Widget with renderer
 */
var defineRenderer;
var defineWidget;

module.exports = function defineComponent(def) {
    if (def._isWidget) {
        return def;
    }

    var renderer;

    if (def.template || def.renderer) {
        renderer = defineRenderer(def);
    } else {
        throw new Error('Expected "template" or "renderer"');
    }

    return defineWidget(def, renderer);
};

defineRenderer = require('/marko-widgets$6.4.1/lib/defineRenderer'/*'./defineRenderer'*/);
defineWidget = require('/marko-widgets$6.4.1/lib/defineWidget-browser'/*'./defineWidget'*/);


});
$_mod.def("/marko-widgets$6.4.1/lib/Widget", function(require, exports, module, __filename, __dirname) { /*
 * Copyright 2011 eBay Software Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
var inherit = require('/raptor-util$2.0.0/inherit'/*'raptor-util/inherit'*/);
var raptorDom = require('/raptor-dom$1.1.1/raptor-dom-client'/*'raptor-dom'*/);
var markoWidgets = require('/marko-widgets$6.4.1/lib/index-browser'/*'./'*/);
var raptorRenderer = require('/raptor-renderer$1.4.6/lib/raptor-renderer'/*'raptor-renderer'*/);
var EventEmitter = require('/events$1.1.1/events'/*'events'*/).EventEmitter;
var listenerTracker = require('/listener-tracker$1.2.0/lib/listener-tracker'/*'listener-tracker'*/);
var arrayFromArguments = require('/raptor-util$2.0.0/arrayFromArguments'/*'raptor-util/arrayFromArguments'*/);
var extend = require('/raptor-util$2.0.0/extend'/*'raptor-util/extend'*/);
var updateManager = require('/marko-widgets$6.4.1/lib/update-manager'/*'./update-manager'*/);
var morphdom = require('/morphdom$1.4.6/lib/index'/*'morphdom'*/);

var MORPHDOM_SKIP = false;

var WIDGET_SUBSCRIBE_TO_OPTIONS = null;
var NON_WIDGET_SUBSCRIBE_TO_OPTIONS = {
    addDestroyListener: false
};


var emit = EventEmitter.prototype.emit;
var idRegExp = /^\#(\S+)( .*)?/;

var lifecycleEventMethods = {
    'beforeDestroy': 'onBeforeDestroy',
    'destroy': 'onDestroy',
    'beforeUpdate': 'onBeforeUpdate',
    'update': 'onUpdate',
    'render': 'onRender',
    'beforeInit': 'onBeforeInit',
    'afterInit': 'onAfterInit'
};

function removeListener(eventListenerHandle) {
    eventListenerHandle.remove();
}

function destroyRecursive(el) {
    raptorDom.forEachChildEl(el, function (childEl) {
        var descendentWidget = childEl.__widget;
        if (descendentWidget) {
            destroy(descendentWidget, false, false);
        }
        destroyRecursive(childEl);
    });
}

/**
 * This method handles invoking a widget's event handler method
 * (if present) while also emitting the event through
 * the standard EventEmitter.prototype.emit method.
 *
 * Special events and their corresponding handler methods
 * include the following:
 *
 * beforeDestroy --> onBeforeDestroy
 * destroy       --> onDestroy
 * beforeUpdate  --> onBeforeUpdate
 * update        --> onUpdate
 * render        --> onRender
 */
function emitLifecycleEvent(widget, eventType, eventArg) {
    var listenerMethod = widget[lifecycleEventMethods[eventType]];

    if (listenerMethod) {
        listenerMethod.call(widget, eventArg);
    }

    widget.emit(eventType, eventArg);
}

function removeDOMEventListeners(widget) {
    var eventListenerHandles = widget.__evHandles;
    if (eventListenerHandles) {
        eventListenerHandles.forEach(removeListener);
        widget.__evHandles = null;
    }
}

function destroy(widget, removeNode, recursive) {
    if (widget.isDestroyed()) {
        return;
    }

    var rootEl = widget.getEl();

    emitLifecycleEvent(widget, 'beforeDestroy');
    widget.__lifecycleState = 'destroyed';

    if (rootEl) {
        if (recursive) {
            destroyRecursive(rootEl);
        }

        if (removeNode && rootEl.parentNode) {
            //Remove the widget's DOM nodes from the DOM tree if the root element is known
            rootEl.parentNode.removeChild(rootEl);
        }

        rootEl.__widget = null;
    }

    // Unsubscribe from all DOM events
    removeDOMEventListeners(widget);

    if (widget.__subscriptions) {
        widget.__subscriptions.removeAllListeners();
        widget.__subscriptions = null;
    }

    emitLifecycleEvent(widget, 'destroy');
}

function setState(widget, name, value, forceDirty, noQueue) {
    if (typeof value === 'function') {
        return;
    }

    if (value === null) {
        // Treat null as undefined to simplify our comparison logic
        value = undefined;
    }

    if (forceDirty) {
        var dirtyState = widget.__dirtyState || (widget.__dirtyState = {});
        dirtyState[name] = true;
    } else if (widget.state[name] === value) {
        return;
    }

    var clean = !widget.__dirty;

    if (clean) {
        // This is the first time we are modifying the widget state
        // so introduce some properties to do some tracking of
        // changes to the state
        var currentState = widget.state;
        widget.__dirty = true; // Mark the widget state as dirty (i.e. modified)
        widget.__oldState = currentState;
        widget.state = extend({}, currentState);
        widget.__stateChanges = {};
    }

    widget.__stateChanges[name] = value;

    if (value == null) {
        // Don't store state properties with an undefined or null value
        delete widget.state[name];
    } else {
        // Otherwise, store the new value in the widget state
        widget.state[name] = value;
    }

    if (clean && noQueue !== true) {
        // If we were clean before then we are now dirty so queue
        // up the widget for update
        updateManager.queueWidgetUpdate(widget);
    }
}

function replaceState(widget, newState, noQueue) {
    var k;

    for (k in widget.state) {
        if (widget.state.hasOwnProperty(k) && !newState.hasOwnProperty(k)) {
            setState(widget, k, undefined, false, noQueue);
        }
    }

    for (k in newState) {
        if (newState.hasOwnProperty(k)) {
            setState(widget, k, newState[k], false, noQueue);
        }
    }
}

function resetWidget(widget) {
    widget.__oldState = null;
    widget.__dirty = false;
    widget.__stateChanges = null;
    widget.__newProps = null;
    widget.__dirtyState = null;
}

function hasCompatibleWidget(widgetsContext, existingWidget) {
    var id = existingWidget.id;
    var newWidgetDef = widgetsContext.getWidget(id);
    if (!newWidgetDef) {
        return false;
    }

    return existingWidget.__type === newWidgetDef.type;
}

var widgetProto;

/**
 * Base widget type.
 *
 * NOTE: Any methods that are prefixed with an underscore should be considered private!
 */
function Widget(id, document) {
    EventEmitter.call(this);
    this.id = id;
    this.el = null;
    this.bodyEl = null;
    this.state = null;
    this.__subscriptions = null;
    this.__evHandles = null;
    this.__lifecycleState = null;
    this.__customEvents = null;
    this.__scope = null;
    this.__dirty = false;
    this.__oldState = null;
    this.__stateChanges = null;
    this.__updateQueued = false;
    this.__dirtyState = null;
    this.__document = document;
}

Widget.prototype = widgetProto = {
    _isWidget: true,

    subscribeTo: function(target) {
        if (!target) {
            throw new Error('target is required');
        }

        var tracker = this.__subscriptions;
        if (!tracker) {
            this.__subscriptions = tracker = listenerTracker.createTracker();
        }


        var subscribeToOptions = target._isWidget ?
            WIDGET_SUBSCRIBE_TO_OPTIONS :
            NON_WIDGET_SUBSCRIBE_TO_OPTIONS;

        return tracker.subscribeTo(target, subscribeToOptions);
    },

    emit: function(eventType) {
        var customEvents = this.__customEvents;
        var targetMethodName;
        var args;

        if (customEvents && (targetMethodName = customEvents[eventType])) {
            args = args || arrayFromArguments(arguments, 1);
            args.push(this);

            var targetWidget = markoWidgets.getWidgetForEl(this.__scope);
            var targetMethod = targetWidget[targetMethodName];
            if (!targetMethod) {
                throw new Error('Method not found for widget ' + targetWidget.id + ': ' + targetMethodName);
            }

            targetMethod.apply(targetWidget, args);
        }

        return emit.apply(this, arguments);
    },
    getElId: function (widgetElId, index) {
        var elId = widgetElId != null ? this.id + '-' + widgetElId : this.id;

        if (index != null) {
            elId += '[' + index + ']';
        }

        return elId;
    },
    getEl: function (widgetElId, index) {
        if (widgetElId != null) {
            return this.__document.getElementById(this.getElId(widgetElId, index));
        } else {
            return this.el || this.__document.getElementById(this.getElId());
        }
    },
    getEls: function(id) {
        var els = [];
        var i=0;
        while(true) {
            var el = this.getEl(id, i);
            if (!el) {
                break;
            }
            els.push(el);
            i++;
        }
        return els;
    },
    getWidget: function(id, index) {
        var targetWidgetId = this.getElId(id, index);
        return markoWidgets.getWidgetForEl(targetWidgetId, this.__document);
    },
    getWidgets: function(id) {
        var widgets = [];
        var i=0;
        while(true) {
            var widget = this.getWidget(id, i);
            if (!widget) {
                break;
            }
            widgets.push(widget);
            i++;
        }
        return widgets;
    },
    destroy: function (options) {
        options = options || {};
        destroy(this, options.removeNode !== false, options.recursive !== false);
    },
    isDestroyed: function () {
        return this.__lifecycleState === 'destroyed';
    },
    getBodyEl: function() {
        return this.bodyEl;
    },
    setState: function(name, value) {
        if (typeof name === 'object') {
            // Merge in the new state with the old state
            var newState = name;
            for (var k in newState) {
                if (newState.hasOwnProperty(k)) {
                    setState(this, k, newState[k]);
                }
            }
            return;
        }

        setState(this, name, value);
    },

    setStateDirty: function(name, value) {
        if (arguments.length === 1) {
            value = this.state[name];
        }

        setState(this, name, value, true /* forceDirty */);
    },

    _replaceState: function(newState) {
        replaceState(this, newState, true /* do not queue an update */ );
    },

    _removeDOMEventListeners: function() {
        removeDOMEventListeners(this);
    },

    replaceState: function(newState) {
        replaceState(this, newState);
    },

    /**
     * Recalculate the new state from the given props using the widget's
     * getInitialState(props) method. If the widget does not have a
     * getInitialState(props) then it is re-rendered with the new props
     * as input.
     *
     * @param {Object} props The widget's new props
     */
    setProps: function(newProps) {
        if (this.getInitialState) {
            if (this.getInitialProps) {
                newProps = this.getInitialProps(newProps) || {};
            }
            var newState = this.getInitialState(newProps);
            this.replaceState(newState);
            return;
        }

        if (!this.__newProps) {
            updateManager.queueWidgetUpdate(this);
        }

        this.__newProps = newProps;
    },

    update: function() {
        if (this.isDestroyed()) {
          return;
        }

        var newProps = this.__newProps;

        if (this.shouldUpdate(newProps, this.state) === false) {
            resetWidget(this);
            return;
        }

        if (newProps) {
            resetWidget(this);
            this.rerender(newProps);
            return;
        }

        if (!this.__dirty) {
            // Don't even bother trying to update this widget since it is
            // not marked as dirty.
            return;
        }

        if (!this._processUpdateHandlers()) {
            this.doUpdate(this.__stateChanges, this.__oldState);
        }

        // Reset all internal properties for tracking state changes, etc.
        resetWidget(this);
    },

    isDirty: function() {
        return this.__dirty;
    },

    _reset: function() {
        resetWidget(this);
    },

    /**
     * This method is used to process "update_<stateName>" handler functions.
     * If all of the modified state properties have a user provided update handler
     * then a rerender will be bypassed and, instead, the DOM will be updated
     * looping over and invoking the custom update handlers.
     * @return {boolean} Returns true if if the DOM was updated. False, otherwise.
     */
    _processUpdateHandlers: function() {
        var stateChanges = this.__stateChanges;
        var oldState = this.__oldState;

        var handlerMethod;
        var handlers = [];

        var newValue;
        var oldValue;

        for (var propName in stateChanges) {
            if (stateChanges.hasOwnProperty(propName)) {
                newValue = stateChanges[propName];
                oldValue = oldState[propName];

                if (oldValue === newValue) {
                    // Only do an update for this state property if it is actually
                    // different from the old state or if it was forced to be dirty
                    // using setStateDirty(propName)
                    var dirtyState = this.__dirtyState;
                    if (dirtyState == null || !dirtyState.hasOwnProperty(propName)) {
                        continue;
                    }
                }

                var handlerMethodName = 'update_' + propName;

                handlerMethod = this[handlerMethodName];
                if (handlerMethod) {
                    handlers.push([propName, handlerMethod]);
                } else {
                    // This state change does not have a state handler so return false
                    // to force a rerender
                    return false;
                }
            }
        }

        // If we got here then all of the changed state properties have
        // an update handler or there are no state properties that actually
        // changed.

        if (!handlers.length) {
            return true;
        }

        // Otherwise, there are handlers for all of the changed properties
        // so apply the updates using those handlers

        emitLifecycleEvent(this, 'beforeUpdate');

        for (var i=0, len=handlers.length; i<len; i++) {
            var handler = handlers[i];
            var propertyName = handler[0];
            handlerMethod = handler[1];

            newValue = stateChanges[propertyName];
            oldValue = oldState[propertyName];
            handlerMethod.call(this, newValue, oldValue);
        }

        emitLifecycleEvent(this, 'update');

        resetWidget(this);

        return true;
    },

    shouldUpdate: function(newState, newProps) {
        return true;
    },

    doUpdate: function (stateChanges, oldState) {
        this.rerender();
    },

    _emitLifecycleEvent: function(eventType, eventArg) {
        emitLifecycleEvent(this, eventType, eventArg);
    },

    rerender: function(props) {
        var self = this;

        if (!self.renderer) {
            throw new Error('Widget does not have a "renderer" property');
        }

        var elToReplace = this.__document.getElementById(self.id);

        var renderer = self.renderer || self;
        self.__lifecycleState = 'rerender';

        var templateData = extend({}, props || self.state);

        var global = templateData.$global = {};

        global.__rerenderWidget = self;
        global.__rerenderEl = self.el;
        global.__rerender = true;

        if (!props) {
            global.__rerenderState = props ? null : self.state;
        }

        updateManager.batchUpdate(function() {
            var renderResult = raptorRenderer
                .render(renderer, templateData);

            var newNode = renderResult.getNode(self.__document);

            var out = renderResult.out;
            var widgetsContext = out.global.widgets;

            function onNodeDiscarded(node) {
                var widget = node.__widget;
                if (widget) {
                    destroy(widget, false, false);
                }
            }

            function onBeforeElUpdated(fromEl, toEl) {
                var id = fromEl.id;
                var existingWidget;

                var preservedAttrs = toEl.getAttribute('data-w-preserve-attrs');
                if (preservedAttrs) {
                    preservedAttrs = preservedAttrs.split(/\s*[,]\s*/);
                    for (var i=0; i<preservedAttrs.length; i++) {
                        var preservedAttrName = preservedAttrs[i];
                        var preservedAttrValue = fromEl.getAttribute(preservedAttrName);
                        if (preservedAttrValue == null) {
                            toEl.removeAttribute(preservedAttrName);
                        } else {
                            toEl.setAttribute(preservedAttrName, preservedAttrValue);
                        }

                    }
                }

                if (widgetsContext && id) {
                    if (widgetsContext.isPreservedEl(id)) {

                        if (widgetsContext.hasUnpreservedBody(id)) {
                            existingWidget = fromEl.__widget;

                            morphdom(existingWidget.bodyEl, toEl, {
                                childrenOnly: true,
                                onNodeDiscarded: onNodeDiscarded,
                                onBeforeElUpdated: onBeforeElUpdated,
                                onBeforeElChildrenUpdated: onBeforeElChildrenUpdated
                            });
                        }

                        // Don't morph elements that are associated with widgets that are being
                        // reused or elements that are being preserved. For widgets being reused,
                        // the morphing will take place when the reused widget updates.
                        return MORPHDOM_SKIP;
                    } else {
                        existingWidget = fromEl.__widget;
                        if (existingWidget && !hasCompatibleWidget(widgetsContext, existingWidget)) {
                            // We found a widget in an old DOM node that does not have
                            // a compatible widget that was rendered so we need to
                            // destroy the old widget
                            destroy(existingWidget, false, false);
                        }
                    }
                }
            }

            function onBeforeElChildrenUpdated(el) {
                if (widgetsContext && el.id) {
                    if (widgetsContext.isPreservedBodyEl(el.id)) {
                        // Don't morph the children since they are preserved
                        return MORPHDOM_SKIP;
                    }
                }
            }

            morphdom(elToReplace, newNode, {
                onNodeDiscarded: onNodeDiscarded,
                onBeforeElUpdated: onBeforeElUpdated,
                onBeforeElChildrenUpdated: onBeforeElChildrenUpdated
            });

            // Trigger any 'onUpdate' events for all of the rendered widgets
            renderResult.afterInsert(self.__document);

            self.__lifecycleState = null;

            if (!props) {
                // We have re-rendered with the new state so our state
                // is no longer dirty. Before updating a widget
                // we check if a widget is dirty. If a widget is not
                // dirty then we abort the update. Therefore, if the
                // widget was queued for update and the re-rendered
                // before the update occurred then nothing will happen
                // at the time of the update.
                resetWidget(self);
            }
        });
    },

    detach: function () {
        raptorDom.detach(this.el);

    },
    appendTo: function (targetEl) {
        raptorDom.appendTo(this.el, targetEl);
    },
    replace: function (targetEl) {
        raptorDom.replace(this.el, targetEl);
    },
    replaceChildrenOf: function (targetEl) {
        raptorDom.replaceChildrenOf(this.el, targetEl);
    },
    insertBefore: function (targetEl) {
        raptorDom.insertBefore(this.el, targetEl);
    },
    insertAfter: function (targetEl) {
        raptorDom.insertAfter(this.el, targetEl);
    },
    prependTo: function (targetEl) {
        raptorDom.prependTo(this.el, targetEl);
    },
    ready: function (callback) {
        markoWidgets.ready(callback, this);
    },
    $: function (arg) {
        var jquery = markoWidgets.$;

        var args = arguments;
        if (args.length === 1) {
            //Handle an "ondomready" callback function
            if (typeof arg === 'function') {
                var _this = this;
                return _this.ready(function() {
                    arg.call(_this);
                });
            } else if (typeof arg === 'string') {
                var match = idRegExp.exec(arg);
                //Reset the search to 0 so the next call to exec will start from the beginning for the new string
                if (match != null) {
                    var widgetElId = match[1];
                    if (match[2] == null) {
                        return jquery(this.getEl(widgetElId));
                    } else {
                        return jquery('#' + this.getElId(widgetElId) + match[2]);
                    }
                } else {
                    var rootEl = this.getEl();
                    if (!rootEl) {
                        throw new Error('Root element is not defined for widget');
                    }
                    if (rootEl) {
                        return jquery(arg, rootEl);
                    }
                }
            }
        } else if (args.length === 2 && typeof args[1] === 'string') {
            return jquery(arg, this.getEl(args[1]));
        } else if (args.length === 0) {
            return jquery(this.el);
        }
        return jquery.apply(window, arguments);
    }
};

widgetProto.elId = widgetProto.getElId;

inherit(Widget, EventEmitter);

module.exports = Widget;

});
$_mod.def("/marko-widgets$6.4.1/lib/defineWidget-browser", function(require, exports, module, __filename, __dirname) { /*
 * Copyright 2011 eBay Software Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
 var BaseWidget;
 var inherit;

module.exports = function defineWidget(def, renderer) {
    if (def._isWidget) {
        return def;
    }

    var extendWidget = def.extendWidget;
    if (extendWidget) {
        return {
            renderer: renderer,
            render: renderer.render,
            extendWidget: function(widget) {
                extendWidget(widget);
                widget.renderer = renderer;
            }
        };
    }

    var WidgetClass;
    var proto;

    if (typeof def === 'function') {
        WidgetClass = def;
        proto = WidgetClass.prototype;

        if (proto.render && proto.render.length === 2) {
            throw new Error('"render(input, out)" is no longer supported. Use "renderer(input, out)" instead.');
        }
    } else if (typeof def === 'object') {
        WidgetClass = def.init || function() {};
        proto = WidgetClass.prototype = def;
    } else {
        throw new Error('Invalid widget');
    }

    // We don't use the constructor provided by the user
    // since we don't invoke their constructor until
    // we have had a chance to do our own initialization.
    // Instead, we store their constructor in the "initWidget"
    // property and that method gets called later inside
    // init-widgets-browser.js
    function Widget(id, document) {
        BaseWidget.call(this, id, document);
    }

    if (!proto._isWidget) {
        // Inherit from Widget if they didn't already
        inherit(WidgetClass, BaseWidget);
    }

    // The same prototype will be used by our constructor after
    // we he have set up the prototype chain using the inherit function
    proto = Widget.prototype = WidgetClass.prototype;

    proto.initWidget = WidgetClass;

    proto.constructor = def.constructor = Widget;

    // Set a flag on the constructor function to make it clear this is
    // a widget so that we can short-circuit this work later
    Widget._isWidget = true;

    if (renderer) {
        // Add the rendering related methods as statics on the
        // new widget constructor function
        Widget.renderer = proto.renderer = renderer;
        Widget.render = renderer.render;
    }

    return Widget;
};

BaseWidget = require('/marko-widgets$6.4.1/lib/Widget'/*'./Widget'*/);
inherit = require('/raptor-util$2.0.0/inherit'/*'raptor-util/inherit'*/);


});
$_mod.def("/marko-widgets$6.4.1/lib/registry", function(require, exports, module, __filename, __dirname) { /*
 * Copyright 2011 eBay Software Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var registered = {};
var loaded = {};
var widgetTypes = {};
var defineWidget;
var defineRenderer;

exports.register = function(typeName, type) {
    if (arguments.length === 1) {
        var widgetType = arguments[0];
        typeName = widgetType.name;
        type = widgetType.def();
    }
    registered[typeName] = type;
    delete loaded[typeName];
    delete widgetTypes[typeName];
};

function load(typeName) {
    var target = loaded[typeName];
    if (target === undefined) {
        target = registered[typeName];
        if (!target) {
            target = require(typeName); // Assume the typeName has been fully resolved already
        }
        loaded[typeName] = target || null;
    }

    if (target == null) {
        throw new Error('Unable to load: ' + typeName);
    }
    return target;
}

function getWidgetClass(typeName) {
    var WidgetClass = widgetTypes[typeName];

    if (WidgetClass) {
        return WidgetClass;
    }

    WidgetClass = load(typeName);

    var renderer;


    if (WidgetClass.Widget) {
        WidgetClass = WidgetClass.Widget;
    }

    if (WidgetClass.renderer) {
        renderer = defineRenderer(WidgetClass);
    }

    WidgetClass = defineWidget(WidgetClass, renderer);

    // Make the widget "type" accessible on each widget instance
    WidgetClass.prototype.__type = typeName;

    widgetTypes[typeName] = WidgetClass;

    return WidgetClass;
}

exports.load = load;

exports.createWidget = function(typeName, id, document) {
    var WidgetClass = getWidgetClass(typeName);
    var widget;
    if (typeof WidgetClass === 'function') {
        // The widget is a constructor function that we can invoke to create a new instance of the widget
        widget = new WidgetClass(id, document);
    } else if (WidgetClass.initWidget) {
        widget = WidgetClass;
        widget.__document = document;
    }
    return widget;
};

defineWidget = require('/marko-widgets$6.4.1/lib/defineWidget-browser'/*'./defineWidget'*/);
defineRenderer = require('/marko-widgets$6.4.1/lib/defineRenderer'/*'./defineRenderer'*/);
});
$_mod.def("/marko-widgets$6.4.1/lib/bubble", function(require, exports, module, __filename, __dirname) { /*
 * Copyright 2011 eBay Software Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
module.exports = [
    /* Mouse Events */
    'click',
    'dblclick',
    'mousedown',
    'mouseup',
    // 'mouseover',
    // 'mousemove',
    // 'mouseout',
    'dragstart',
    'drag',
    // 'dragenter',
    // 'dragleave',
    // 'dragover',
    'drop',
    'dragend',

    /* Keyboard Events */
    'keydown',
    'keypress',
    'keyup',

    /* Form Events */
    'select',
    'change',
    'submit',
    'reset'
    // 'focus', <-- Does not bubble
    // 'blur', <-- Does not bubble
    // 'focusin', <-- Not supported in all browsers
    // 'focusout' <-- Not supported in all browsers
];
});
$_mod.def("/marko-widgets$6.4.1/lib/event-delegation", function(require, exports, module, __filename, __dirname) { var _addEventListener = require('/marko-widgets$6.4.1/lib/addEventListener'/*'./addEventListener'*/);
var updateManager = require('/marko-widgets$6.4.1/lib/update-manager'/*'./update-manager'*/);

var attachBubbleEventListeners = function() {
    var body = document.body;
    // Here's where we handle event delegation using our own mechanism
    // for delegating events. For each event that we have white-listed
    // as supporting bubble, we will attach a listener to the root
    // document.body element. When we get notified of a triggered event,
    // we again walk up the tree starting at the target associated
    // with the event to find any mappings for event. Each mapping
    // is from a DOM event type to a method of a widget.
    require('/marko-widgets$6.4.1/lib/bubble'/*'./bubble'*/).forEach(function addBubbleHandler(eventType) {
        _addEventListener(body, eventType, function(event) {
            var propagationStopped = false;

            // Monkey-patch to fix #97
            var oldStopPropagation = event.stopPropagation;

            event.stopPropagation = function() {
                oldStopPropagation.call(event);
                propagationStopped = true;
            };

            updateManager.batchUpdate(function() {
                var curNode = event.target;
                if (!curNode) {
                    return;
                }

                // Search up the tree looking DOM events mapped to target
                // widget methods
                var attrName = 'data-w-on' + eventType;
                var targetMethod;
                var targetWidget;

                // Attributes will have the following form:
                // w-on<event_type>="<target_method>|<widget_id>"

                do {
                    if ((targetMethod = curNode.getAttribute(attrName))) {
                        var separator = targetMethod.lastIndexOf('|');
                        var targetWidgetId = targetMethod.substring(separator+1);
                        var targetWidgetEl = document.getElementById(targetWidgetId);
                        if (!targetWidgetEl) {
                            // The target widget is not in the DOM anymore
                            // which can happen when the widget and its
                            // children are removed from the DOM while
                            // processing the event.
                            continue;
                        }

                        targetWidget = targetWidgetEl.__widget;

                        if (!targetWidget) {
                            throw new Error('Widget not found: ' + targetWidgetId);
                        }
                        targetMethod = targetMethod.substring(0, separator);

                        var targetFunc = targetWidget[targetMethod];
                        if (!targetFunc) {
                            throw new Error('Method not found on widget ' + targetWidget.id + ': ' + targetMethod);
                        }

                        // Invoke the widget method
                        targetWidget[targetMethod](event, curNode);
                        if (propagationStopped) {
                            break;
                        }
                    }
                } while((curNode = curNode.parentNode) && curNode.getAttribute);
            });
        });
    });
};

exports.init = function() {
    if (attachBubbleEventListeners) {
        // Only attach event listeners once...
        attachBubbleEventListeners();
        attachBubbleEventListeners = null; // This is a one time thing
    }
};
});
$_mod.def("/marko-widgets$6.4.1/lib/init-widgets-browser", function(require, exports, module, __filename, __dirname) { /*
 * Copyright 2011 eBay Software Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

require('/raptor-polyfill$1.0.2/array/forEach'/*'raptor-polyfill/array/forEach'*/);
require('/raptor-polyfill$1.0.2/string/endsWith'/*'raptor-polyfill/string/endsWith'*/);

var logger = require('/raptor-logging$1.1.2/lib/index'/*'raptor-logging'*/).logger(module);
var raptorPubsub = require('/raptor-pubsub$1.0.5/lib/index'/*'raptor-pubsub'*/);
var ready = require('/raptor-dom$1.1.1/raptor-dom-client'/*'raptor-dom'*/).ready;
var _addEventListener = require('/marko-widgets$6.4.1/lib/addEventListener'/*'./addEventListener'*/);
var registry = require('/marko-widgets$6.4.1/lib/registry'/*'./registry'*/);
var warp10Finalize = require('/warp10$1.3.0/finalize'/*'warp10/finalize'*/);
var eventDelegation = require('/marko-widgets$6.4.1/lib/event-delegation'/*'./event-delegation'*/);

function invokeWidgetEventHandler(widget, targetMethodName, args) {
    var method = widget[targetMethodName];
    if (!method) {
        throw new Error('Widget ' + widget.id + ' does not have method named "' + targetMethodName + '"');
    }

    method.apply(widget, args);
}

function addDOMEventListener(widget, el, eventType, targetMethodName) {
    return _addEventListener(el, eventType, function(event) {
        invokeWidgetEventHandler(widget, targetMethodName, [event, el]);
    });
}

function getNestedEl(widget, nestedId, document) {
    if (nestedId == null) {
        return null;

    }
    if (nestedId === '') {
        return widget.getEl();
    }

    if (typeof nestedId === 'string' && nestedId.charAt(0) === '#') {
        return document.getElementById(nestedId.substring(1));
    } else {
        return widget.getEl(nestedId);
    }
}

function initWidget(
    type,
    id,
    config,
    state,
    scope,
    domEvents,
    customEvents,
    extendList,
    bodyElId,
    existingWidget,
    el,
    document) {

    var i;
    var len;
    var eventType;
    var targetMethodName;
    var widget;

    if (!el) {
        el = document.getElementById(id);
    }

    if (!existingWidget) {
        existingWidget = el.__widget;
    }

    if (existingWidget && existingWidget.__type !== type) {
        existingWidget = null;
    }

    if (existingWidget) {
        existingWidget._removeDOMEventListeners();
        existingWidget._reset();
        widget = existingWidget;
    } else {
        widget = registry.createWidget(type, id, document);
    }

    if (state) {
        for (var k in state) {
            if (state.hasOwnProperty(k)) {
                var v = state[k];
                if (typeof v === 'function' || v == null) {
                    delete state[k];
                }
            }
        }
    }

    widget.state = state || {}; // First time rendering so use the provided state or an empty state object

    // The user-provided constructor function
    if (logger.isDebugEnabled()) {
        logger.debug('Creating widget: ' + type + ' (' + id + ')');
    }

    if (!config) {
        config = {};
    }

    el.__widget = widget;

    if (widget._isWidget) {
        widget.el = el;
        widget.bodyEl = getNestedEl(widget, bodyElId, document);

        if (domEvents) {
            var eventListenerHandles = [];

            for (i=0, len=domEvents.length; i<len; i+=3) {
                eventType = domEvents[i];
                targetMethodName = domEvents[i+1];
                var eventElId = domEvents[i+2];
                var eventEl = getNestedEl(widget, eventElId, document);

                // The event mapping is for a DOM event (not a custom event)
                var eventListenerHandle = addDOMEventListener(widget, eventEl, eventType, targetMethodName);
                eventListenerHandles.push(eventListenerHandle);
            }

            if (eventListenerHandles.length) {
                widget.__evHandles = eventListenerHandles;
            }
        }

        if (customEvents) {
            widget.__customEvents = {};
            widget.__scope = scope;

            for (i=0, len=customEvents.length; i<len; i+=2) {
                eventType = customEvents[i];
                targetMethodName = customEvents[i+1];
                widget.__customEvents[eventType] = targetMethodName;
            }
        }

        if (extendList) {
            // If one or more "w-extend" attributes were used for this
            // widget then call those modules to now extend the widget
            // that we created
            for (i=0, len=extendList.length; i<len; i++) {
                var extendType = extendList[i];

                if (!existingWidget) {
                    // Only extend a widget the first time the widget is created. If we are updating
                    // an existing widget then we don't re-extend it
                    var extendModule = registry.load(extendType);
                    var extendFunc = extendModule.extendWidget || extendModule.extend;

                    if (typeof extendFunc !== 'function') {
                        throw new Error('extendWidget(widget, cfg) method missing: ' + extendType);
                    }

                    extendFunc(widget);
                }
            }
        }
    } else {
        config.elId = id;
        config.el = el;
    }

    if (existingWidget) {
        widget._emitLifecycleEvent('update');
        widget._emitLifecycleEvent('render', {});
    } else {
        var initEventArgs = {
            widget: widget,
            config: config
        };

        raptorPubsub.emit('marko-widgets/initWidget', initEventArgs);

        widget._emitLifecycleEvent('beforeInit', initEventArgs);
        widget.initWidget(config);
        widget._emitLifecycleEvent('afterInit', initEventArgs);

        widget._emitLifecycleEvent('render', { firstRender: true });
    }

    return widget;
}

function initWidgetFromEl(el, state, config) {
    if (el.__widget != null) {
        // A widget is already bound to this element. Nothing to do...
        return;
    }

    var document = el.ownerDocument;
    var scope;
    var id = el.id;
    var type = el.getAttribute('data-widget');
    el.removeAttribute('data-widget');

    var domEvents;
    var hasDomEvents = el.getAttribute('data-w-on');
    if (hasDomEvents) {
        var domEventsEl = document.getElementById(id + '-$on');
        if (domEventsEl) {
            domEventsEl.parentNode.removeChild(domEventsEl);
            domEvents = (domEventsEl.getAttribute('data-on') || '').split(',');
        }

        el.removeAttribute('data-w-on');
    }

    var customEvents = el.getAttribute('data-w-events');
    if (customEvents) {
        customEvents = customEvents.split(',');
        scope = customEvents[0];
        customEvents = customEvents.slice(1);
        el.removeAttribute('data-w-events');
    }

    var extendList = el.getAttribute('data-w-extend');
    if (extendList) {
        extendList = extendList.split(',');
        el.removeAttribute('data-w-extend');
    }

    var bodyElId = el.getAttribute('data-w-body');

    initWidget(
        type,
        id,
        config,
        state,
        scope,
        domEvents,
        customEvents,
        extendList,
        bodyElId,
        null,
        el,
        document);
}


// Create a helper function handle recursion
function initClientRendered(widgetDefs, document) {
    // Ensure that event handlers to handle delegating events are
    // always attached before initializing any widgets
    eventDelegation.init();

    document = document || window.document;
    for (var i=0,len=widgetDefs.length; i<len; i++) {
        var widgetDef = widgetDefs[i];

        if (widgetDef.children.length) {
            initClientRendered(widgetDef.children, document);
        }

        var widget = initWidget(
            widgetDef.type,
            widgetDef.id,
            widgetDef.config,
            widgetDef.state,
            widgetDef.scope,
            widgetDef.domEvents,
            widgetDef.customEvents,
            widgetDef.extend,
            widgetDef.bodyElId,
            widgetDef.existingWidget,
            null,
            document);

        widgetDef.widget = widget;
    }
}

/**
 * This method is used to initialized widgets associated with UI components
 * rendered in the browser. While rendering UI components a "widgets context"
 * is added to the rendering context to keep up with which widgets are rendered.
 * When ready, the widgets can then be initialized by walking the widget tree
 * in the widgets context (nested widgets are initialized before ancestor widgets).
 * @param  {Array<marko-widgets/lib/WidgetDef>} widgetDefs An array of WidgetDef instances
 */
exports.initClientRendered = initClientRendered;

/**
 * This method initializes all widgets that were rendered on the server by iterating over all
 * of the widget IDs. This method supports two signatures:
 *
 * initServerRendered(dataIds : String) - dataIds is a comma separated list of widget IDs. The state and config come
 *                                        from the following globals:
 *                                        - window.$markoWidgetsState
 *                                        - window.$markoWidgetsConfig
 * initServerRendered(renderedWidgets : Object) - dataIds is an object rendered by getRenderedWidgets with the following
 *                                                structure:
 *   {
 *   	ids: "w0,w1,w2",
 *   	state: { w0: {...}, ... }
 *   	config: { w0: {...}, ... }
 *   }
 */
exports.initServerRendered = function(dataIds) {
    var stateStore;
    var configStore;

    if (typeof dataIds === 'object') {
        stateStore = dataIds.state ? warp10Finalize(dataIds.state) : null;
        configStore = dataIds.config ? warp10Finalize(dataIds.config) : null;
        dataIds = dataIds.ids;
    }

    function doInit() {
        // Ensure that event handlers to handle delegating events are
        // always attached before initializing any widgets
        eventDelegation.init();
        
        if (typeof dataIds !== 'string') {
            var idsEl = document.getElementById('markoWidgets');
            if (!idsEl) { // If there is no index then do nothing
                return;
            }

            // Make sure widgets are only initialized once by checking a flag
            if (document.markoWidgetsInitialized === true) {
                return;
            }

            // Set flag to avoid trying to do this multiple times
            document.markoWidgetsInitialized = true;

            dataIds = idsEl ? idsEl.getAttribute('data-ids') : null;

        }

        if (dataIds) {

            stateStore = stateStore || window.$markoWidgetsState;
            configStore = configStore || window.$markoWidgetsConfig;

            // W have a comma-separated of widget element IDs that need to be initialized
            var ids = dataIds.split(',');
            var len = ids.length;
            var state;
            var config;
            for (var i=0; i<len; i++) {
                var id = ids[i];
                var el = document.getElementById(id);
                if (!el) {
                    throw new Error('DOM node for widget with ID "' + id + '" not found');
                }

                if (stateStore) {
                    state = stateStore[id];
                    delete stateStore[id];
                } else {
                    state = undefined;
                }

                if (configStore) {
                    config = configStore[id];
                    delete configStore[id];
                } else {
                    config = undefined;
                }

                initWidgetFromEl(el, state, config);
            }
        }
    }

    if (typeof dataIds === 'string') {
        doInit();
    } else {
        ready(doInit);
    }
};
});
$_mod.def("/marko-widgets$6.4.1/lib/client-init", function(require, exports, module, __filename, __dirname) { /*
 * Copyright 2011 eBay Software Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

require('/marko-widgets$6.4.1/lib/init-widgets-browser'/*'./init-widgets'*/).initServerRendered();
});
$_mod.def("/marko-widgets$6.4.1/lib/index-browser", function(require, exports, module, __filename, __dirname) { /*
 * Copyright 2011 eBay Software Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
var raptorPubsub = require('/raptor-pubsub$1.0.5/lib/index'/*'raptor-pubsub'*/);
var ready = require('/raptor-dom$1.1.1/raptor-dom-client'/*'raptor-dom'*/).ready;
var EMPTY_OBJ = {};
var Widget = require('/marko-widgets$6.4.1/lib/Widget'/*'./Widget'*/);
var initWidgets = require('/marko-widgets$6.4.1/lib/init-widgets-browser'/*'./init-widgets'*/);
var raptorRenderer = require('/raptor-renderer$1.4.6/lib/raptor-renderer'/*'raptor-renderer'*/);
var updateManager = require('/marko-widgets$6.4.1/lib/update-manager'/*'./update-manager'*/);

// Exports:
var WidgetsContext = exports.WidgetsContext = require('/marko-widgets$6.4.1/lib/WidgetsContext'/*'./WidgetsContext'*/);
exports.getWidgetsContext = WidgetsContext.getWidgetsContext;
exports.Widget = Widget;
exports.ready = ready;
exports.onInitWidget = function(listener) {
    raptorPubsub.on('marko-widgets/initWidget', listener);
};
exports.attrs = function() {
    return EMPTY_OBJ;
};

exports.writeDomEventsEl = function() {
    /* Intentionally empty in the browser */
};

function getWidgetForEl(id, document) {
    if (!id) {
        return undefined;
    }

    var node = typeof id === 'string' ? (document || window.document).getElementById(id) : id;
    return (node && node.__widget) || undefined;
}

exports.get = exports.getWidgetForEl = getWidgetForEl;

exports.initAllWidgets = function() {
    initWidgets.initServerRendered(true /* scan DOM */);
};

// Subscribe to DOM manipulate events to handle creating and destroying widgets
raptorPubsub
    .on('dom/beforeRemove', function(eventArgs) {
        var el = eventArgs.el;
        var widget = el.id ? getWidgetForEl(el) : null;
        if (widget) {
            widget.destroy({
                removeNode: false,
                recursive: true
            });
        }
    })
    .on('raptor-renderer/renderedToDOM', function(eventArgs) {
        var out = eventArgs.out || eventArgs.context;
        var widgetsContext = out.global.widgets;
        if (widgetsContext) {
            widgetsContext.initWidgets(eventArgs.document);
        }
    });

exports.initWidgets = window.$markoWidgets = function(ids) {
    initWidgets.initServerRendered(ids);
};

var JQUERY = 'jquery';
var jquery = window.$;

if (!jquery) {
    try {
        jquery = require(JQUERY);
    }
    catch(e) {}
}

exports.$ = jquery;

exports.registerWidget = require('/marko-widgets$6.4.1/lib/registry'/*'./registry'*/).register;
exports.makeRenderable = exports.renderable = raptorRenderer.renderable;
exports.render = raptorRenderer.render;
exports.defineComponent = require('/marko-widgets$6.4.1/lib/defineComponent'/*'./defineComponent'*/);
exports.defineWidget = require('/marko-widgets$6.4.1/lib/defineWidget-browser'/*'./defineWidget'*/);
exports.defineRenderer = require('/marko-widgets$6.4.1/lib/defineRenderer'/*'./defineRenderer'*/);
exports.batchUpdate = updateManager.batchUpdate;
exports.onAfterUpdate = updateManager.onAfterUpdate;

window.$MARKO_WIDGETS = exports; // Helpful when debugging... WARNING: DO NOT USE IN REAL CODE!

});