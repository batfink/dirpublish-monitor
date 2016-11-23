/*
GOAL: This module should mirror the NodeJS module system according the documented behavior.
The module transport will send down code that registers module definitions by an assigned path. In addition,
the module transport will send down code that registers additional metadata to allow the module resolver to
resolve modules in the browser. Additional metadata includes the following:

- "mains": The mapping of module directory paths to a fully resolved module path
- "remaps": The remapping of one fully resolved module path to another fully resolved module path (used for browser overrides)
- "run": A list of entry point modules that should be executed when ready

Inspired by:
https://github.com/joyent/node/blob/master/lib/module.js
*/
(function() {
    var win;

    if (typeof window !== 'undefined') {
        win = window;

        // This lasso modules client has already been loaded on the page. Do nothing;
        if (win.$_mod) {
            return;
        }

        win.global = win;
    }

    /** the module runtime */
    var $_mod;

    // this object stores the module factories with the keys being module paths and
    // values being a factory function or object (e.g. "/baz$3.0.0/lib/index" --> Function)
    var definitions = {};

    // Search path that will be checked when looking for modules
    var searchPaths = [];

    // The _ready flag is used to determine if "run" modules can
    // be executed or if they should be deferred until all dependencies
    // have been loaded
    var _ready = false;

    // If $_mod.run() is called when the page is not ready then
    // we queue up the run modules to be executed later
    var runQueue = [];

    // this object stores the Module instance cache with the keys being paths of modules (e.g., "/foo$1.0.0/bar" --> Module)
    var instanceCache = {};

    // This object maps installed dependencies to specific versions
    //
    // For example:
    // {
    //   // The package "foo" with version 1.0.0 has an installed package named "bar" (foo/node_modules/bar") and
    //   // the version of "bar" is 3.0.0
    //   "/foo$1.0.0/bar": "3.0.0"
    // }
    var installed = {};

    // Maps builtin modules such as "path", "buffer" to their fully resolved paths
    var builtins = {};

    // this object maps a directory to the fully resolved module path
    //
    // For example:
    //
    var mains = {};

    // used to remap a one fully resolved module path to another fully resolved module path
    var remapped = {};

    var cacheByDirname = {};

    // When a module is mapped to a global varialble we add a reference
    // that maps the path of the module to the loaded global instance.
    // We use this mapping to ensure that global modules are only loaded
    // once if they map to the same path.
    //
    // See issue #5 - Ensure modules mapped to globals only load once
    // https://github.com/raptorjs/raptor-modules/issues/5
    var loadedGlobalsByRealPath = {};

    function moduleNotFoundError(target, from) {
        var err = new Error('Cannot find module "' + target + '"' + (from ? ' from "' + from + '"' : ''));

        err.code = 'MODULE_NOT_FOUND';
        return err;
    }

    function Module(filename) {
       /*
        A Node module has these properties:
        - filename: The path of the module
        - id: The path of the module (same as filename)
        - exports: The exports provided during load
        - loaded: Has module been fully loaded (set to false until factory function returns)

        NOT SUPPORTED:
        - parent: parent Module
        - paths: The search path used by this module (NOTE: not documented in Node.js module system so we don't need support)
        - children: The modules that were required by this module
        */
        this.id = this.filename = filename;
        this.loaded = false;
        this.exports = undefined;
    }

    Module.cache = instanceCache;

    // temporary variable for referencing the Module prototype
    var Module_prototype = Module.prototype;

    Module_prototype.load = function(factoryOrObject) {
        var filename = this.id;

        if (factoryOrObject && factoryOrObject.constructor === Function) {
            // factoryOrObject is definitely a function
            var lastSlashPos = filename.lastIndexOf('/');

            // find the value for the __dirname parameter to factory
            var dirname = filename.substring(0, lastSlashPos);

            // local cache for requires initiated from this module/dirname
            var localCache = cacheByDirname[dirname] || (cacheByDirname[dirname] = {});

            // this is the require used by the module
            var instanceRequire = function(target) {
                // Only store the `module` in the local cache since `module.exports` may not be accurate
                // if there was a circular dependency
                var module = localCache[target] || (localCache[target] = requireModule(target, dirname));
                return module.exports;
            };

            // The require method should have a resolve method that will return the resolved
            // path but not actually instantiate the module.
            // This resolve function will make sure a definition exists for the corresponding
            // path of the target but it will not instantiate a new instance of the target.
            instanceRequire.resolve = function(target) {
                if (!target) {
                    throw moduleNotFoundError('');
                }

                var resolved = resolve(target, dirname);

                if (!resolved) {
                    throw moduleNotFoundError(target, dirname);
                }

                // NOTE: resolved[0] is the path and resolved[1] is the module factory
                return resolved[0];
            };

            // NodeJS provides access to the cache as a property of the "require" function
            instanceRequire.cache = instanceCache;

            // Expose the module system runtime via the `runtime` property
            // TODO: We should deprecate this in favor of `Module.prototype.__runtime`
            // @deprecated
            instanceRequire.runtime = $_mod;

            // $_mod.def("/foo$1.0.0/lib/index", function(require, exports, module, __filename, __dirname) {
            this.exports = {};

            // call the factory function
            factoryOrObject.call(this, instanceRequire, this.exports, this, filename, dirname);
        } else {
            // factoryOrObject is not a function so have exports reference factoryOrObject
            this.exports = factoryOrObject;
        }

        this.loaded = true;
    };

    /**
     * Defines a packages whose metadata is used by raptor-loader to load the package.
     */
    function define(path, factoryOrObject, options) {
        /*
        $_mod.def('/baz$3.0.0/lib/index', function(require, exports, module, __filename, __dirname) {
            // module source code goes here
        });
        */

        var globals = options && options.globals;

        definitions[path] = factoryOrObject;

        if (globals) {
            var target = win || global;
            for (var i=0;i<globals.length; i++) {
                var globalVarName = globals[i];
                var globalModule = loadedGlobalsByRealPath[path] = requireModule(path);
                target[globalVarName] = globalModule.exports;
            }
        }
    }

    function registerMain(path, relativePath) {
        mains[path] = relativePath;
    }

    function remap(fromPath, toPath) {
        remapped[fromPath] = toPath;
    }

    function builtin(name, target) {
        builtins[name] = target;
    }

    function registerInstalledDependency(parentPath, packageName, packageVersion) {
        // Example:
        // dependencies['/my-package$1.0.0/$/my-installed-package'] = '2.0.0'
        installed[parentPath + '/' + packageName] =  packageVersion;
    }

    /**
     * This function will take an array of path parts and normalize them by handling handle ".." and "."
     * and then joining the resultant string.
     *
     * @param {Array} parts an array of parts that presumedly was split on the "/" character.
     */
    function normalizePathParts(parts) {

        // IMPORTANT: It is assumed that parts[0] === "" because this method is used to
        // join an absolute path to a relative path
        var i;
        var len = 0;

        var numParts = parts.length;

        for (i = 0; i < numParts; i++) {
            var part = parts[i];

            if (part === '.') {
                // ignore parts with just "."
                /*
                // if the "." is at end of parts (e.g. ["a", "b", "."]) then trim it off
                if (i === numParts - 1) {
                    //len--;
                }
                */
            } else if (part === '..') {
                // overwrite the previous item by decrementing length
                len--;
            } else {
                // add this part to result and increment length
                parts[len] = part;
                len++;
            }
        }

        if (len === 1) {
            // if we end up with just one part that is empty string
            // (which can happen if input is ["", "."]) then return
            // string with just the leading slash
            return '/';
        } else if (len > 2) {
            // parts i s
            // ["", "a", ""]
            // ["", "a", "b", ""]
            if (parts[len - 1].length === 0) {
                // last part is an empty string which would result in trailing slash
                len--;
            }
        }

        // truncate parts to remove unused
        parts.length = len;
        return parts.join('/');
    }

    function join(from, target) {
        var targetParts = target.split('/');
        var fromParts = from == '/' ? [''] : from.split('/');
        return normalizePathParts(fromParts.concat(targetParts));
    }

    function withoutExtension(path) {
        var lastDotPos = path.lastIndexOf('.');
        var lastSlashPos;

        /* jshint laxbreak:true */
        return ((lastDotPos === -1) || ((lastSlashPos = path.lastIndexOf('/')) !== -1) && (lastSlashPos > lastDotPos))
            ? null // use null to indicate that returned path is same as given path
            : path.substring(0, lastDotPos);
    }

    function splitPackageIdAndSubpath(path) {
        path = path.substring(1); /* Skip past the first slash */
        // Examples:
        //     '/my-package$1.0.0/foo/bar' --> ['my-package$1.0.0', '/foo/bar']
        //     '/my-package$1.0.0' --> ['my-package$1.0.0', '']
        //     '/my-package$1.0.0/' --> ['my-package$1.0.0', '/']
        //     '/@my-scoped-package/foo/$1.0.0/' --> ['@my-scoped-package/foo$1.0.0', '/']
        var slashPos = path.indexOf('/');

        if (path.charAt(1) === '@') {
            // path is something like "/@my-user-name/my-scoped-package/subpath"
            // For scoped packages, the package name is two parts. We need to skip
            // past the second slash to get the full package name
            slashPos = path.indexOf('/', slashPos+1);
        }

        var packageIdEnd = slashPos === -1 ? path.length : slashPos;

        return [
            path.substring(0, packageIdEnd), // Everything up to the slash
            path.substring(packageIdEnd) // Everything after the package ID
        ];
    }

    function resolveInstalledModule(target, from) {
        // Examples:
        // target='foo', from='/my-package$1.0.0/hello/world'

        if (target.charAt(target.length-1) === '/') {
            // This is a hack because I found require('util/') in the wild and
            // it did not work because of the trailing slash
            target = target.slice(0, -1);
        }

        // Check to see if the target module is a builtin module.
        // For example:
        // builtins['path'] = '/path-browserify$0.0.0/index'
        var builtinPath = builtins[target];
        if (builtinPath) {
            return builtinPath;
        }

        var fromParts = splitPackageIdAndSubpath(from);
        var fromPackageId = fromParts[0];


        var targetSlashPos = target.indexOf('/');
        var targetPackageName;
        var targetSubpath;

        if (targetSlashPos < 0) {
            targetPackageName = target;
            targetSubpath = '';
        } else {

            if (target.charAt(0) === '@') {
                // target is something like "@my-user-name/my-scoped-package/subpath"
                // For scoped packages, the package name is two parts. We need to skip
                // past the first slash to get the full package name
                targetSlashPos = target.indexOf('/', targetSlashPos + 1);
            }

            targetPackageName = target.substring(0, targetSlashPos);
            targetSubpath = target.substring(targetSlashPos);
        }

        var targetPackageVersion = installed[fromPackageId + '/' + targetPackageName];
        if (targetPackageVersion) {
            var resolvedPath = '/' + targetPackageName + '$' + targetPackageVersion;
            if (targetSubpath) {
                resolvedPath += targetSubpath;
            }
            return resolvedPath;
        }
    }

    function resolve(target, from) {
        var resolvedPath;

        if (target.charAt(0) === '.') {
            // turn relative path into absolute path
            resolvedPath = join(from, target);
        } else if (target.charAt(0) === '/') {
            // handle targets such as "/my/file" or "/$/foo/$/baz"
            resolvedPath = normalizePathParts(target.split('/'));
        } else {
            var len = searchPaths.length;
            for (var i = 0; i < len; i++) {
                // search path entries always end in "/";
                var candidate = searchPaths[i] + target;
                var resolved = resolve(candidate, from);
                if (resolved) {
                    return resolved;
                }
            }

            resolvedPath = resolveInstalledModule(target, from);
        }

        if (!resolvedPath) {
            return undefined;
        }

        // target is something like "/foo/baz"
        // There is no installed module in the path
        var relativePath;

        // check to see if "target" is a "directory" which has a registered main file
        if ((relativePath = mains[resolvedPath]) !== undefined) {
            if (!relativePath) {
                relativePath = 'index';
            }

            // there is a main file corresponding to the given target so add the relative path
            resolvedPath = join(resolvedPath, relativePath);
        }

        var remappedPath = remapped[resolvedPath];
        if (remappedPath) {
            resolvedPath = remappedPath;
        }

        var factoryOrObject = definitions[resolvedPath];
        if (factoryOrObject === undefined) {
            // check for definition for given path but without extension
            var resolvedPathWithoutExtension;
            if (((resolvedPathWithoutExtension = withoutExtension(resolvedPath)) === null) ||
                ((factoryOrObject = definitions[resolvedPathWithoutExtension]) === undefined)) {
                return undefined;
            }

            // we found the definition based on the path without extension so
            // update the path
            resolvedPath = resolvedPathWithoutExtension;
        }

        return [resolvedPath, factoryOrObject];
    }

    function requireModule(target, from) {
        if (!target) {
            throw moduleNotFoundError('');
        }

        var resolved = resolve(target, from);
        if (!resolved) {
            throw moduleNotFoundError(target, from);
        }

        var resolvedPath = resolved[0];

        var module = instanceCache[resolvedPath];

        if (module !== undefined) {
            // found cached entry based on the path
            return module;
        }

        // Fixes issue #5 - Ensure modules mapped to globals only load once
        // https://github.com/raptorjs/raptor-modules/issues/5
        //
        // If a module is mapped to a global variable then we want to always
        // return that global instance of the module when it is being required
        // to avoid duplicate modules being loaded. For modules that are mapped
        // to global variables we also add an entry that maps the path
        // of the module to the global instance of the loaded module.

        if (loadedGlobalsByRealPath.hasOwnProperty(resolvedPath)) {
            return loadedGlobalsByRealPath[resolvedPath];
        }

        var factoryOrObject = resolved[1];

        module = new Module(resolvedPath);

        // cache the instance before loading (allows support for circular dependency with partial loading)
        instanceCache[resolvedPath] = module;

        module.load(factoryOrObject);

        return module;
    }

    function require(target, from) {
        var module = requireModule(target, from);
        return module.exports;
    }

    /*
    $_mod.run('/$/installed-module', '/src/foo');
    */
    function run(path, options) {
        var wait = !options || (options.wait !== false);
        if (wait && !_ready) {
            return runQueue.push([path, options]);
        }

        require(path, '/');
    }

    /*
     * Mark the page as being ready and execute any of the
     * run modules that were deferred
     */
    function ready() {
        _ready = true;

        var len;
        while((len = runQueue.length)) {
            // store a reference to the queue before we reset it
            var queue = runQueue;

            // clear out the queue
            runQueue = [];

            // run all of the current jobs
            for (var i = 0; i < len; i++) {
                var args = queue[i];
                run(args[0], args[1]);
            }

            // stop running jobs in the queue if we change to not ready
            if (!_ready) {
                break;
            }
        }
    }

    function addSearchPath(prefix) {
        searchPaths.push(prefix);
    }

    var pendingCount = 0;
    var onPendingComplete = function() {
        pendingCount--;
        if (!pendingCount) {
            // Trigger any "require-run" modules in the queue to run
            ready();
        }
    };

    /*
     * $_mod is the short-hand version that that the transport layer expects
     * to be in the browser window object
     */
    Module_prototype.__runtime = $_mod = {
        /**
         * Used to register a module factory/object (*internal*)
         */
        def: define,

        /**
         * Used to register an installed dependency (e.g. "/$/foo" depends on "baz") (*internal*)
         */
        installed: registerInstalledDependency,
        run: run,
        main: registerMain,
        remap: remap,
        builtin: builtin,
        require: require,
        resolve: resolve,
        join: join,
        ready: ready,

        /**
         * Add a search path entry (internal)
         */
        searchPath: addSearchPath,

        /**
         * Sets the loader metadata for this build.
         *
         * @param asyncPackageName {String} name of asynchronous package
         * @param contentType {String} content type ("js" or "css")
         * @param bundleUrl {String} URL of bundle that belongs to package
         */
        loaderMetadata: function(data) {
            // We store loader metadata in the prototype of Module
            // so that `lasso-loader` can read it from
            // `module.__loaderMetadata`.
            Module_prototype.__loaderMetadata = data;
        },

        /**
         * Asynchronous bundle loaders should call `pending()` to instantiate
         * a new job. The object we return here has a `done` method that
         * should be called when the job completes. When the number of
         * pending jobs drops to 0, we invoke any of the require-run modules
         * that have been declared.
         */
        pending: function() {
            _ready = false;
            pendingCount++;
            return {
                done: onPendingComplete
            };
        }
    };

    if (win) {
        win.$_mod = $_mod;
    } else {
        module.exports = $_mod;
    }
})();

$_mod.installed("dirpublish-monitor$1.0.0", "normalize.css", "5.0.0");
$_mod.installed("dirpublish-monitor$1.0.0", "marko-widgets", "6.4.1");
$_mod.installed("marko-widgets$6.4.1", "raptor-polyfill", "1.0.2");
$_mod.def("/raptor-polyfill$1.0.2/array/_toObject", function(require, exports, module, __filename, __dirname) { var prepareString = "a"[0] != "a";

// ES5 9.9
// http://es5.github.com/#x9.9
module.exports = function (o) {
    if (o == null) { // this matches both null and undefined
        throw new TypeError("can't convert "+o+" to object");
    }
    // If the implementation doesn't support by-index access of
    // string characters (ex. IE < 9), split the string
    if (prepareString && typeof o == "string" && o) {
        return o.split("");
    }
    return Object(o);
};
});
$_mod.def("/raptor-polyfill$1.0.2/array/forEach", function(require, exports, module, __filename, __dirname) { // ES5 15.4.4.18
// http://es5.github.com/#x15.4.4.18
// https://developer.mozilla.org/en/JavaScript/Reference/Global_Objects/array/forEach

if (!Array.prototype.forEach) {
    var toObject = require('/raptor-polyfill$1.0.2/array/_toObject'/*'./_toObject'*/);

    Array.prototype.forEach = function forEach(func, thisObj) {
        var self = toObject(this);
        var i = -1;
        var length = self.length >>> 0;

        // If no callback function or if callback is not a callable function
        if (typeof func !== 'function') {
            throw new TypeError();
        }

        while (++i < length) {
            if (i in self) {
                // Invoke the callback function with call, passing arguments:
                // context, property value, property key, thisArg object context
                func.call(thisObj, self[i], i, self);
            }
        }
    };
}
});
$_mod.def("/raptor-polyfill$1.0.2/string/endsWith", function(require, exports, module, __filename, __dirname) { if (!String.prototype.endsWith) {
    String.prototype.endsWith = function(suffix, position) {
        var str = this;
        
        if (position) {
            str = str.substring(position);
        }
        
        if (str.length < suffix.length) {
            return false;
        }
        
        return str.slice(0 - suffix.length) == suffix;
    };
}
});
$_mod.installed("marko-widgets$6.4.1", "raptor-logging", "1.1.2");
$_mod.main("/raptor-logging$1.1.2", "lib/index");
$_mod.builtin("process", "/process$0.6.0/browser");
$_mod.def("/process$0.6.0/browser", function(require, exports, module, __filename, __dirname) { // shim for using process in browser

var process = module.exports = {};

process.nextTick = (function () {
    var canSetImmediate = typeof window !== 'undefined'
    && window.setImmediate;
    var canPost = typeof window !== 'undefined'
    && window.postMessage && window.addEventListener
    ;

    if (canSetImmediate) {
        return function (f) { return window.setImmediate(f) };
    }

    if (canPost) {
        var queue = [];
        window.addEventListener('message', function (ev) {
            var source = ev.source;
            if ((source === window || source === null) && ev.data === 'process-tick') {
                ev.stopPropagation();
                if (queue.length > 0) {
                    var fn = queue.shift();
                    fn();
                }
            }
        }, true);

        return function nextTick(fn) {
            queue.push(fn);
            window.postMessage('process-tick', '*');
        };
    }

    return function nextTick(fn) {
        setTimeout(fn, 0);
    };
})();

process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];

function noop() {}

process.on = noop;
process.once = noop;
process.off = noop;
process.emit = noop;

process.binding = function (name) {
    throw new Error('process.binding is not supported');
}

// TODO(shtylman)
process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};

});
$_mod.def("/raptor-logging$1.1.2/lib/raptor-logging", function(require, exports, module, __filename, __dirname) { var process=require("process"); var EMPTY_FUNC = function() {
        return false;
    },
    /**
     * @name raptor/logging/voidLogger
     */
    voidLogger = {

        /**
         *
         */
        isTraceEnabled: EMPTY_FUNC,

        /**
         *
         */
        isDebugEnabled: EMPTY_FUNC,

        /**
         *
         */
        isInfoEnabled: EMPTY_FUNC,

        /**
         *
         */
        isWarnEnabled: EMPTY_FUNC,

        /**
         *
         */
        isErrorEnabled: EMPTY_FUNC,

        /**
         *
         */
        isFatalEnabled: EMPTY_FUNC,

        /**
         *
         */
        dump: EMPTY_FUNC,

        /**
         *
         */
        trace: EMPTY_FUNC,

        /**
         *
         */
        debug: EMPTY_FUNC,

        /**
         *
         */
        info: EMPTY_FUNC,

        /**
         *
         */
        warn: EMPTY_FUNC,

        /**
         *
         */
        error: EMPTY_FUNC,

        /**
         *
         */
        fatal: EMPTY_FUNC
    };

var stubs = {
    /**
     *
     * @param className
     * @returns
     */
    logger: function() {
        return voidLogger;
    },

    configure: EMPTY_FUNC,

    voidLogger: voidLogger
};


module.exports = stubs;

// Trick the JavaScript module bundler so that it doesn't include the implementation automatically
var RAPTOR_LOGGING_IMPL = './raptor-logging-impl';

if (!process.browser) {
    var implPath;

    try {
        implPath = require.resolve(RAPTOR_LOGGING_IMPL);
    } catch(e) {
        /*
        Fixes https://github.com/raptorjs/raptor-logging/issues/4
        If `./raptor-logging-impl` is unable to be loaded then it means that a server bundle was built and it does
        not support dynamic requires since the server bundle is being loaded from a different
        directory that breaks the relative path.
        */
    }
    if (implPath) {
        require(implPath);
    }
}
});
$_mod.def("/raptor-logging$1.1.2/lib/index", function(require, exports, module, __filename, __dirname) { var g = typeof window === 'undefined' ? global : window;
// Make this module a true singleton
module.exports = g.__RAPTOR_LOGGING || (g.__RAPTOR_LOGGING = require('/raptor-logging$1.1.2/lib/raptor-logging'/*'./raptor-logging'*/));
});
$_mod.installed("marko-widgets$6.4.1", "raptor-pubsub", "1.0.5");
$_mod.main("/raptor-pubsub$1.0.5", "lib/index");
$_mod.builtin("events", "/events$1.1.1/events");
$_mod.def("/events$1.1.1/events", function(require, exports, module, __filename, __dirname) { // Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

function EventEmitter() {
  this._events = this._events || {};
  this._maxListeners = this._maxListeners || undefined;
}
module.exports = EventEmitter;

// Backwards-compat with node 0.10.x
EventEmitter.EventEmitter = EventEmitter;

EventEmitter.prototype._events = undefined;
EventEmitter.prototype._maxListeners = undefined;

// By default EventEmitters will print a warning if more than 10 listeners are
// added to it. This is a useful default which helps finding memory leaks.
EventEmitter.defaultMaxListeners = 10;

// Obviously not all Emitters should be limited to 10. This function allows
// that to be increased. Set to zero for unlimited.
EventEmitter.prototype.setMaxListeners = function(n) {
  if (!isNumber(n) || n < 0 || isNaN(n))
    throw TypeError('n must be a positive number');
  this._maxListeners = n;
  return this;
};

EventEmitter.prototype.emit = function(type) {
  var er, handler, len, args, i, listeners;

  if (!this._events)
    this._events = {};

  // If there is no 'error' event listener then throw.
  if (type === 'error') {
    if (!this._events.error ||
        (isObject(this._events.error) && !this._events.error.length)) {
      er = arguments[1];
      if (er instanceof Error) {
        throw er; // Unhandled 'error' event
      } else {
        // At least give some kind of context to the user
        var err = new Error('Uncaught, unspecified "error" event. (' + er + ')');
        err.context = er;
        throw err;
      }
    }
  }

  handler = this._events[type];

  if (isUndefined(handler))
    return false;

  if (isFunction(handler)) {
    switch (arguments.length) {
      // fast cases
      case 1:
        handler.call(this);
        break;
      case 2:
        handler.call(this, arguments[1]);
        break;
      case 3:
        handler.call(this, arguments[1], arguments[2]);
        break;
      // slower
      default:
        args = Array.prototype.slice.call(arguments, 1);
        handler.apply(this, args);
    }
  } else if (isObject(handler)) {
    args = Array.prototype.slice.call(arguments, 1);
    listeners = handler.slice();
    len = listeners.length;
    for (i = 0; i < len; i++)
      listeners[i].apply(this, args);
  }

  return true;
};

EventEmitter.prototype.addListener = function(type, listener) {
  var m;

  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  if (!this._events)
    this._events = {};

  // To avoid recursion in the case that type === "newListener"! Before
  // adding it to the listeners, first emit "newListener".
  if (this._events.newListener)
    this.emit('newListener', type,
              isFunction(listener.listener) ?
              listener.listener : listener);

  if (!this._events[type])
    // Optimize the case of one listener. Don't need the extra array object.
    this._events[type] = listener;
  else if (isObject(this._events[type]))
    // If we've already got an array, just append.
    this._events[type].push(listener);
  else
    // Adding the second element, need to change to array.
    this._events[type] = [this._events[type], listener];

  // Check for listener leak
  if (isObject(this._events[type]) && !this._events[type].warned) {
    if (!isUndefined(this._maxListeners)) {
      m = this._maxListeners;
    } else {
      m = EventEmitter.defaultMaxListeners;
    }

    if (m && m > 0 && this._events[type].length > m) {
      this._events[type].warned = true;
      console.error('(node) warning: possible EventEmitter memory ' +
                    'leak detected. %d listeners added. ' +
                    'Use emitter.setMaxListeners() to increase limit.',
                    this._events[type].length);
      if (typeof console.trace === 'function') {
        // not supported in IE 10
        console.trace();
      }
    }
  }

  return this;
};

EventEmitter.prototype.on = EventEmitter.prototype.addListener;

EventEmitter.prototype.once = function(type, listener) {
  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  var fired = false;

  function g() {
    this.removeListener(type, g);

    if (!fired) {
      fired = true;
      listener.apply(this, arguments);
    }
  }

  g.listener = listener;
  this.on(type, g);

  return this;
};

// emits a 'removeListener' event iff the listener was removed
EventEmitter.prototype.removeListener = function(type, listener) {
  var list, position, length, i;

  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  if (!this._events || !this._events[type])
    return this;

  list = this._events[type];
  length = list.length;
  position = -1;

  if (list === listener ||
      (isFunction(list.listener) && list.listener === listener)) {
    delete this._events[type];
    if (this._events.removeListener)
      this.emit('removeListener', type, listener);

  } else if (isObject(list)) {
    for (i = length; i-- > 0;) {
      if (list[i] === listener ||
          (list[i].listener && list[i].listener === listener)) {
        position = i;
        break;
      }
    }

    if (position < 0)
      return this;

    if (list.length === 1) {
      list.length = 0;
      delete this._events[type];
    } else {
      list.splice(position, 1);
    }

    if (this._events.removeListener)
      this.emit('removeListener', type, listener);
  }

  return this;
};

EventEmitter.prototype.removeAllListeners = function(type) {
  var key, listeners;

  if (!this._events)
    return this;

  // not listening for removeListener, no need to emit
  if (!this._events.removeListener) {
    if (arguments.length === 0)
      this._events = {};
    else if (this._events[type])
      delete this._events[type];
    return this;
  }

  // emit removeListener for all listeners on all events
  if (arguments.length === 0) {
    for (key in this._events) {
      if (key === 'removeListener') continue;
      this.removeAllListeners(key);
    }
    this.removeAllListeners('removeListener');
    this._events = {};
    return this;
  }

  listeners = this._events[type];

  if (isFunction(listeners)) {
    this.removeListener(type, listeners);
  } else if (listeners) {
    // LIFO order
    while (listeners.length)
      this.removeListener(type, listeners[listeners.length - 1]);
  }
  delete this._events[type];

  return this;
};

EventEmitter.prototype.listeners = function(type) {
  var ret;
  if (!this._events || !this._events[type])
    ret = [];
  else if (isFunction(this._events[type]))
    ret = [this._events[type]];
  else
    ret = this._events[type].slice();
  return ret;
};

EventEmitter.prototype.listenerCount = function(type) {
  if (this._events) {
    var evlistener = this._events[type];

    if (isFunction(evlistener))
      return 1;
    else if (evlistener)
      return evlistener.length;
  }
  return 0;
};

EventEmitter.listenerCount = function(emitter, type) {
  return emitter.listenerCount(type);
};

function isFunction(arg) {
  return typeof arg === 'function';
}

function isNumber(arg) {
  return typeof arg === 'number';
}

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}

function isUndefined(arg) {
  return arg === void 0;
}

});
$_mod.def("/raptor-pubsub$1.0.5/lib/raptor-pubsub", function(require, exports, module, __filename, __dirname) { var EventEmitter = require('/events$1.1.1/events'/*'events'*/).EventEmitter;

var channels = {};

var globalChannel = new EventEmitter();

globalChannel.channel = function(name) {
    var channel;
    if (name) {
        channel = channels[name] || (channels[name] = new EventEmitter());
    } else {
        channel = new EventEmitter();
    }
    return channel;
};

globalChannel.removeChannel = function(name) {
    delete channels[name];
};

module.exports = globalChannel;

});
$_mod.def("/raptor-pubsub$1.0.5/lib/index", function(require, exports, module, __filename, __dirname) { var g = typeof window === 'undefined' ? global : window;
// Make this module a true singleton
module.exports = g.__RAPTOR_PUBSUB || (g.__RAPTOR_PUBSUB = require('/raptor-pubsub$1.0.5/lib/raptor-pubsub'/*'./raptor-pubsub'*/));
});
$_mod.installed("marko-widgets$6.4.1", "raptor-dom", "1.1.1");
$_mod.main("/raptor-dom$1.1.1", "raptor-dom-server");
$_mod.remap("/raptor-dom$1.1.1/raptor-dom-server", "/raptor-dom$1.1.1/raptor-dom-client");
$_mod.installed("raptor-dom$1.1.1", "raptor-pubsub", "1.0.5");
$_mod.def("/raptor-dom$1.1.1/ready", function(require, exports, module, __filename, __dirname) { /*
    jQuery's doc.ready/$(function(){}) should
    you wish to use a cross-browser domReady solution
    without opting for a library.

    Demo: http://jsfiddle.net/zKLpb/

    usage:
    $(function(){
        // your code
    });

    Parts: jQuery project, Diego Perini, Lucent M.
    Previous version from Addy Osmani (https://raw.github.com/addyosmani/jquery.parts/master/jquery.documentReady.js)

    This version: Patrick Steele-Idem
    - Converted to CommonJS module
    - Code cleanup
    - Fixes for IE <=10
*/

var isReady = false;
var readyBound = false;

var win = window;
var doc = document;

var listeners = [];

function domReadyCallback() {
    for (var i = 0, len = listeners.length; i < len; i++) {
        var listener = listeners[i];
        listener[0].call(listener[1]);
    }
    listeners = null;
}

// Handle when the DOM is ready
function domReady() {
    // Make sure that the DOM is not already loaded
    if (!isReady) {
        // Make sure body exists, at least, in case IE gets a little overzealous (ticket #5443).
        if (!doc.body) {
            return setTimeout(domReady, 1);
        }
        // Remember that the DOM is ready
        isReady = true;
        // If there are functions bound, to execute
        domReadyCallback();
        // Execute all of them
    }
} // /ready()

// The ready event handler
function domContentLoaded() {
    if (doc.addEventListener) {
        doc.removeEventListener("DOMContentLoaded", domContentLoaded, false);
    } else {
        // we're here because readyState !== "loading" in oldIE
        // which is good enough for us to call the dom ready!
        doc.detachEvent("onreadystatechange", domContentLoaded);
    }
    domReady();
}

// The DOM ready check for Internet Explorer
function doScrollCheck() {
    if (isReady) {
        return;
    }

    try {
        // If IE is used, use the trick by Diego Perini
        // http://javascript.nwbox.com/IEContentLoaded/
        doc.documentElement.doScroll("left");
    } catch (error) {
        setTimeout(doScrollCheck, 1);
        return;
    }
    // and execute any waiting functions
    domReady();
}

function bindReady() {
    var toplevel = false;

    // Catch cases where $ is called after the
    // browser event has already occurred. IE <= 10 has a bug that results in 'interactive' being assigned
    // to the readyState before the DOM is really ready
    if (document.attachEvent ? document.readyState === "complete" : document.readyState !== "loading") {
        // We will get here if the browser is IE and the readyState === 'complete' or the browser
        // is not IE and the readyState === 'interactive' || 'complete'
        domReady();
    } else if (doc.addEventListener) { // Standards-based browsers support DOMContentLoaded
        // Use the handy event callback
        doc.addEventListener("DOMContentLoaded", domContentLoaded, false);
        // A fallback to win.onload, that will always work
        win.addEventListener("load", domContentLoaded, false);
        // If IE event model is used
    } else if (doc.attachEvent) {
        // ensure firing before onload,
        // maybe late but safe also for iframes
        doc.attachEvent("onreadystatechange", domContentLoaded);
        // A fallback to win.onload, that will always work
        win.attachEvent("onload", domContentLoaded);
        // If IE and not a frame
        // continually check to see if the document is ready
        try {
            toplevel = win.frameElement == null;
        } catch (e) {}
        if (doc.documentElement.doScroll && toplevel) {
            doScrollCheck();
        }
    }
}

module.exports = function(callback, thisObj) {
    if (isReady) {
        return callback.call(thisObj);
    }

    listeners.push([callback, thisObj]);

    if (!readyBound) {
        readyBound = true;
        bindReady();
    }
};
});
$_mod.def("/raptor-dom$1.1.1/raptor-dom-client", function(require, exports, module, __filename, __dirname) { var raptorPubsub = require('/raptor-pubsub$1.0.5/lib/index'/*'raptor-pubsub'*/);

function getNode(el) {
    if (typeof el === 'string') {
        var elId = el;
        el = document.getElementById(elId);
        if (!el) {
            throw new Error('Target element not found: "' + elId + '"');
        }
    }
    return el;
}

function _beforeRemove(referenceEl) {
    if (raptorPubsub) {
        raptorPubsub.emit('dom/beforeRemove', {
            el: referenceEl
        });
    }
}

var dom = {
    forEachChildEl: function(node, callback, scope) {
        dom.forEachChild(node, callback, scope, 1);
    },
    forEachChild: function(node, callback, scope, nodeType) {
        if (!node) {
            return;
        }
        var i = 0;
        var childNodes = node.childNodes;
        var len = childNodes.length;
        for (; i < len; i++) {
            var childNode = childNodes[i];
            if (childNode && (nodeType == null || nodeType == childNode.nodeType)) {
                callback.call(scope, childNode);
            }
        }
    },
    detach: function(child) {
        child = getNode(child);
        child.parentNode.removeChild(child);
    },
    appendTo: function(newChild, referenceParentEl) {
        getNode(referenceParentEl).appendChild(getNode(newChild));
    },
    remove: function(el) {
        el = getNode(el);
        _beforeRemove(el);
        if (el.parentNode) {
            el.parentNode.removeChild(el);
        }
    },
    removeChildren: function(parentEl) {
        parentEl = getNode(parentEl);

        var i = 0;
        var childNodes = parentEl.childNodes;
        var len = childNodes.length;
        for (; i < len; i++) {
            var childNode = childNodes[i];
            if (childNode && childNode.nodeType === 1) {
                _beforeRemove(childNode);
            }
        }
        parentEl.innerHTML = '';
    },
    replace: function(newChild, replacedChild) {
        replacedChild = getNode(replacedChild);
        _beforeRemove(replacedChild);
        replacedChild.parentNode.replaceChild(getNode(newChild), replacedChild);
    },
    replaceChildrenOf: function(newChild, referenceParentEl) {
        referenceParentEl = getNode(referenceParentEl);
        dom.forEachChildEl(referenceParentEl, function(childEl) {
            _beforeRemove(childEl);
        });
        referenceParentEl.innerHTML = '';
        referenceParentEl.appendChild(getNode(newChild));
    },
    insertBefore: function(newChild, referenceChild) {
        referenceChild = getNode(referenceChild);
        referenceChild.parentNode.insertBefore(getNode(newChild), referenceChild);
    },
    insertAfter: function(newChild, referenceChild) {
        referenceChild = getNode(referenceChild);
        newChild = getNode(newChild);
        var nextSibling = referenceChild.nextSibling;
        var parentNode = referenceChild.parentNode;
        if (nextSibling) {
            parentNode.insertBefore(newChild, nextSibling);
        } else {
            parentNode.appendChild(newChild);
        }
    },
    prependTo: function(newChild, referenceParentEl) {
        referenceParentEl = getNode(referenceParentEl);
        referenceParentEl.insertBefore(getNode(newChild), referenceParentEl.firstChild || null);
    }
};

/*
var jquery = window.$;
if (!jquery) {
    try {
        jquery = require('jquery');
    }
    catch(e) {}
}

if (jquery) {
    dom.ready = function(callback, thisObj) {
        jquery(function() {
            callback.call(thisObj);
        });
    };
} else {
    dom.ready = require('./raptor-dom_documentReady');
}
*/
dom.ready = require('/raptor-dom$1.1.1/ready'/*'./ready'*/);

module.exports = dom;
});
$_mod.installed("marko-widgets$6.4.1", "raptor-util", "2.0.0");
$_mod.def("/raptor-util$2.0.0/extend", function(require, exports, module, __filename, __dirname) { module.exports = function extend(target, source) { //A simple function to copy properties from one object to another
    if (!target) { //Check if a target was provided, otherwise create a new empty object to return
        target = {};
    }

    if (source) {
        for (var propName in source) {
            if (source.hasOwnProperty(propName)) { //Only look at source properties that are not inherited
                target[propName] = source[propName]; //Copy the property
            }
        }
    }

    return target;
};
});
$_mod.def("/raptor-util$2.0.0/inherit", function(require, exports, module, __filename, __dirname) { var extend = require('/raptor-util$2.0.0/extend'/*'./extend'*/);

function _inherit(clazz, superclass, copyProps) { //Helper function to setup the prototype chain of a class to inherit from another class's prototype
    
    var proto = clazz.prototype;
    var F = function() {};
    
    F.prototype = superclass.prototype;

    clazz.prototype = new F();
    clazz.$super = superclass;

    if (copyProps !== false) {
        extend(clazz.prototype, proto);
    }

    clazz.prototype.constructor = clazz;
    return clazz;
}

function inherit(clazz, superclass) {
    return _inherit(clazz, superclass, true);
}


module.exports = inherit;

inherit._inherit = _inherit;
});
$_mod.installed("marko-widgets$6.4.1", "raptor-renderer", "1.4.6");
$_mod.main("/raptor-renderer$1.4.6", "lib/raptor-renderer");
$_mod.installed("raptor-renderer$1.4.6", "async-writer", "2.1.2");
$_mod.main("/async-writer$2.1.2", "src/index");
$_mod.def("/async-writer$2.1.2/src/StringWriter", function(require, exports, module, __filename, __dirname) { function StringWriter(events) {
    this.str = '';
    this.events = events;
    this.finished = false;
}

StringWriter.prototype = {
    end: function() {
        this.finished = true;
        if (this.events) {
            this.events.emit('finish');
        }
    },

    write: function(str) {
        this.str += str;
        return this;
    },

    /**
     * Converts the string buffer into a String.
     *
     * @returns {String} The built String
     */
    toString: function() {
        return this.str;
    }
};

module.exports = StringWriter;
});
$_mod.def("/async-writer$2.1.2/src/BufferedWriter", function(require, exports, module, __filename, __dirname) { /**
 * Simple wrapper that can be used to wrap a stream
 * to reduce the number of write calls. In Node.js world,
 * each stream.write() becomes a chunk. We can avoid overhead
 * by reducing the number of chunks by buffering the output.
 */
function BufferedWriter(wrappedStream) {
    this._buffer = '';
    this._wrapped = wrappedStream;
}

BufferedWriter.prototype = {
    write: function(str) {
        this._buffer += str;
    },

    flush: function() {
        if (this._buffer.length !== 0) {
            this._wrapped.write(this._buffer);
            this._buffer = '';
            if (this._wrapped.flush) {
                this._wrapped.flush();
            }
        }
    },

    end: function() {
        this.flush();
        if (!this._wrapped.isTTY) {
            this._wrapped.end();
        }
    },

    clear: function() {
        this._buffer = '';
    }
};

module.exports = BufferedWriter;
});
$_mod.def("/async-writer$2.1.2/src/AsyncStream", function(require, exports, module, __filename, __dirname) { 'use strict';var process=require("process"); 

var EventEmitter = require('/events$1.1.1/events'/*'events'*/).EventEmitter;
var StringWriter = require('/async-writer$2.1.2/src/StringWriter'/*'./StringWriter'*/);
var BufferedWriter = require('/async-writer$2.1.2/src/BufferedWriter'/*'./BufferedWriter'*/);

var voidWriter = { write:function(){} };

function State(root, stream, writer, events) {
    this.root = root;
    this.stream = stream;
    this.writer = writer;
    this.events = events;

    this.remaining = 0;
    this.lastCount = 0;
    this.last = undefined; // Array
    this.ended = false;
    this.finished = false;
    this.ids = 0;
}

function AsyncStream(global, writer, state, shouldBuffer) {
    var finalGlobal = this.attributes = global || {};
    var originalStream;

    if (state) {
        originalStream = state.stream;
    } else {
        var events = finalGlobal.events /* deprecated */ = writer && writer.on ? writer : new EventEmitter();

        if (writer) {
            originalStream = writer;
            if (shouldBuffer) {
                writer = new BufferedWriter(writer);
            }
        } else {
            writer = originalStream = new StringWriter(events);
        }

        state = new State(this, originalStream, writer, events);
    }

    this.global = finalGlobal;
    this.stream = originalStream;
    this._state = state;

    this.data = {};
    this.writer = writer;
    writer.stream = this;

    this._sync = false;
    this._stack = undefined;
    this._timeoutId = undefined;
}

AsyncStream.DEFAULT_TIMEOUT = 10000;
AsyncStream.INCLUDE_STACK = typeof process !== 'undefined' && process.env.NODE_ENV === 'development';
AsyncStream.enableAsyncStackTrace = function() {
    AsyncStream.INCLUDE_STACK = true;
};

var proto = AsyncStream.prototype = {
    constructor: AsyncStream,
    isAsyncWriter: AsyncStream,
    isAsyncStream: AsyncStream,

    sync: function() {
        this._sync = true;
    },

    write: function (str) {
        if (str != null) {
            this.writer.write(str.toString());
        }
        return this;
    },

    getOutput: function () {
        return this._state.writer.toString();
    },

    beginAsync: function(options) {
        if (this._sync) {
            throw new Error('beginAsync() not allowed when using renderSync()');
        }

        var state = this._state;

        var currentWriter = this.writer;

        /* ┏━━━━━┓               this
           ┃ WAS ┃               ↓↑
           ┗━━━━━┛  prevWriter → currentWriter → nextWriter  */

        var newWriter = new StringWriter();
        var newStream = new AsyncStream(this.global, currentWriter, state);

        this.writer = newWriter;
        newWriter.stream = this;

        newWriter.next = currentWriter.next;
        currentWriter.next = newWriter;

        /* ┏━━━━━┓               newStream       this
           ┃ NOW ┃               ↓↑              ↓↑
           ┗━━━━━┛  prevWriter → currentWriter → newWriter → nextWriter  */

       var timeout;
       var name;

       state.remaining++;

       if (options != null) {
           if (typeof options === 'number') {
               timeout = options;
           } else {
               timeout = options.timeout;

               if (options.last === true) {
                   if (timeout == null) {
                       // Don't assign a timeout to last flush fragments
                       // unless it is explicitly given a timeout
                       timeout = 0;
                   }

                   state.lastCount++;
               }

               name = options.name;
           }
       }

       if (timeout == null) {
           timeout = AsyncStream.DEFAULT_TIMEOUT;
       }

       newStream.stack = AsyncStream.INCLUDE_STACK ? new Error().stack : null;
       newStream.name = name;

       if (timeout > 0) {
           newStream._timeoutId = setTimeout(function() {
               newStream.error(new Error('Async fragment ' + (name ? '(' + name + ') ': '') + 'timed out after ' + timeout + 'ms'));
           }, timeout);
       }

       state.events.emit('beginAsync', {
           writer: newStream,
           parentWriter: this
       });

        return newStream;
    },

    end: function(data) {
        if (data) {
            this.write(data);
        }

        var currentWriter = this.writer;

        /* ┏━━━━━┓  this            nextStream
           ┃ WAS ┃  ↓↑              ↓↑
           ┗━━━━━┛  currentWriter → nextWriter → futureWriter  */

        // Prevent any more writes to the current steam
        this.writer = voidWriter;
        currentWriter.stream = null;

        // Flush the contents of nextWriter to the currentWriter
        this.flushNext(currentWriter);

        /* ┏━━━━━┓    this        ╵  nextStream
           ┃     ┃    ↓           ╵  ↓↑
           ┃ NOW ┃    voidWriter  ╵  currentWriter → futureWriter
           ┃     ┃  ──────────────┴────────────────────────────────
           ┗━━━━━┛    Flushed & garbage collected: nextWriter  */


       var state = this._state;

       if (state.finished) {
           return;
       }

       var remaining;

       if (this === state.root) {
           remaining = state.remaining;
           state.ended = true;
       } else {
           var timeoutId = this._timeoutId;

           if (timeoutId) {
               clearTimeout(timeoutId);
           }

           remaining = --state.remaining;
       }

       if (state.ended) {
           if (!state.lastFired && (state.remaining - state.lastCount === 0)) {
               state.lastFired = true;
               state.lastCount = 0;
               state.events.emit('last');
           }

           if (remaining === 0) {
               state.finished = true;
               if (state.writer.end) {
                   state.writer.end();
               } else {
                   state.events.emit('finish');
               }
           }
       }

        return this;
    },

    // flushNextOld: function(currentWriter) {
    //     if (currentWriter === this._state.writer) {
    //         var nextStream;
    //         var nextWriter = currentWriter.next;
    //
    //         // flush until there is no nextWriter
    //         // or the nextWriter is still attached
    //         // to a branch.
    //         while(nextWriter) {
    //             currentWriter.write(nextWriter.toString());
    //             nextStream = nextWriter.stream;
    //
    //             if(nextStream) break;
    //             else nextWriter = nextWriter.next;
    //         }
    //
    //         // Orphan the nextWriter and everything that
    //         // came before it. They have been flushed.
    //         currentWriter.next = nextWriter && nextWriter.next;
    //
    //         // If there is a nextStream,
    //         // set its writer to currentWriter
    //         // (which is the state.writer)
    //         if(nextStream) {
    //             nextStream.writer = currentWriter;
    //             currentWriter.stream = nextStream;
    //         }
    //     }
    // },

    flushNext: function(currentWriter) {
        // It is possible that currentWriter is the
        // last writer in the chain, so let's make
        // sure there is a nextWriter to flush.
        var nextWriter = currentWriter.next;
        if (nextWriter) {
            // Flush the contents of nextWriter
            // to the currentWriter
            currentWriter.write(nextWriter.toString());

            // Remove nextWriter from the chain.
            // It has been flushed and can now be
            // garbage collected.
            currentWriter.next = nextWriter.next;

            // It's possible that nextWriter is the last
            // writer in the chain and its stream already
            // ended, so let's make sure nextStream exists.
            var nextStream = nextWriter.stream;
            if (nextStream) {
                // Point the nextStream to currentWriter
                nextStream.writer = currentWriter;
                currentWriter.stream = nextStream;
            }
        }
    },

    on: function(event, callback) {
        var state = this._state;

        if (event === 'finish' && state.finished) {
            callback();
            return this;
        }

        state.events.on(event, callback);
        return this;
    },

    once: function(event, callback) {
        var state = this._state;

        if (event === 'finish' && state.finished) {
            callback();
            return this;
        }

        state.events.once(event, callback);
        return this;
    },

    onLast: function(callback) {
        var state = this._state;

        var lastArray = state.last;

        if (!lastArray) {
            lastArray = state.last = [];
            var i = 0;
            var next = function next() {
                if (i === lastArray.length) {
                    return;
                }
                var _next = lastArray[i++];
                _next(next);
            };

            this.once('last', function() {
                next();
            });
        }

        lastArray.push(callback);
        return this;
    },

    emit: function(type, arg) {
        var events = this._state.events;
        switch(arguments.length) {
            case 1:
                events.emit(type);
                break;
            case 2:
                events.emit(type, arg);
                break;
            default:
                events.emit.apply(events, arguments);
                break;
        }
        return this;
    },

    removeListener: function() {
        var events = this._state.events;
        events.removeListener.apply(events, arguments);
        return this;
    },

    prependListener: function() {
        var events = this._state.events;
        events.prependListener.apply(events, arguments);
        return this;
    },

    pipe: function(stream) {
        this._state.stream.pipe(stream);
        return this;
    },

    error: function(e) {
        var stack = this._stack;
        var name = this.name;

        var message = 'Async fragment failed' + (name ? ' (' + name + ')': '') + '. Exception: ' + (e.stack || e) + (stack ? ('\nCreation stack trace: ' + stack) : '');
        e = new Error(message);

        try {
            this.emit('error', e);
        } finally {
            // If there is no listener for the error event then it will
            // throw a new here. In order to ensure that the async fragment
            // is still properly ended we need to put the end() in a `finally`
            // block
            this.end();
        }

        if (console) {
            console.error(message);
        }

        return this;
    },

    flush: function() {
        var state = this._state;

        if (!state.finished) {
            var writer = state.writer;
            if (writer && writer.flush) {
                writer.flush();
            }
        }
        return this;
    },

    // Deprecated BEGIN:
    getAttributes: function() {
        return this.global;
    },
    getAttribute: function(name) {
        return this.global[name];
    },

    createOut: function() {
        return new AsyncStream(this.global);
    },

    captureString: function(func, thisObj) {
        var sb = new StringWriter();
        this.swapWriter(sb, func, thisObj);
        return sb.toString();
    },
    swapWriter: function(newWriter, func, thisObj) {
        var currentWriter = this.writer;
        this.writer = newWriter;
        func.call(thisObj);
        this.writer = currentWriter;
    }
    // // Deprecated END
};

// alias:
proto.w = proto.write;

module.exports = AsyncStream;
});
$_mod.def("/async-writer$2.1.2/src/index", function(require, exports, module, __filename, __dirname) { /*
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
 * This module provides the runtime for rendering compiled templates.
 *
 *
 * <p>The code for the Marko compiler is kept separately
 * in the {@link raptor/templating/compiler} module.
 */
'use strict';

var AsyncStream = require('/async-writer$2.1.2/src/AsyncStream'/*'./AsyncStream'*/);

exports.create = function (writer, options) {
    var global;
    var shouldBuffer;

    if(arguments.length === 1 && typeof writer.write !== 'function') {
        options = writer;
        writer = null;
    }

    if (options) {
        global = options.global;
        shouldBuffer = options.buffer === true;
    }

    var asyncStream = new AsyncStream(
        global,
        writer,
        null /* Internally used to pass state */,
        shouldBuffer);    //Create a new context using the writer provided

    return asyncStream;
};

exports.AsyncStream = exports.AsyncWriter /* legacy */ = AsyncStream;
exports.enableAsyncStackTrace = AsyncStream.enableAsyncStackTrace;

});
$_mod.remap("/raptor-renderer$1.4.6/lib/RenderResult", "/raptor-renderer$1.4.6/lib/RenderResult-browser");
$_mod.installed("raptor-renderer$1.4.6", "raptor-dom", "1.1.1");
$_mod.installed("raptor-renderer$1.4.6", "raptor-pubsub", "1.0.5");
$_mod.def("/raptor-renderer$1.4.6/lib/RenderResult-browser", function(require, exports, module, __filename, __dirname) { 'use strict';
var dom = require('/raptor-dom$1.1.1/raptor-dom-client'/*'raptor-dom'*/);
var raptorPubsub = require('/raptor-pubsub$1.0.5/lib/index'/*'raptor-pubsub'*/);

function checkAddedToDOM(renderResult, method) {
    if (!renderResult._added) {
        throw new Error('Cannot call ' + method + '() until after HTML fragment is added to DOM.');
    }
}

function RenderResult(html, out) {
    this.html = html;
    this.out = out;
    this._node = undefined;

    var widgetsContext = out.global.widgets;
    this._widgetDefs = widgetsContext ? widgetsContext.widgets : null;
}

RenderResult.prototype = {
    getWidget: function () {
        checkAddedToDOM(this, 'getWidget');

        var rerenderWidget = this.out.__rerenderWidget;
        if (rerenderWidget) {
            return rerenderWidget;
        }

        var widgetDefs = this._widgetDefs;
        if (!widgetDefs) {
            throw new Error('No widget rendered');
        }
        return widgetDefs.length ? widgetDefs[0].widget : undefined;
    },
    getWidgets: function (selector) {
        checkAddedToDOM(this, 'getWidgets');

        var widgetDefs = this._widgetDefs;

        if (!widgetDefs) {
            throw new Error('No widget rendered');
        }

        var widgets;
        var i;
        if (selector) {
            // use the selector to find the widgets that the caller wants
            widgets = [];
            for (i = 0; i < widgetDefs.length; i++) {
                var widget = widgetDefs[i].widget;
                if (selector(widget)) {
                    widgets.push(widget);
                }
            }
        } else {
            // return all widgets
            widgets = new Array(widgetDefs.length);
            for (i = 0; i < widgetDefs.length; i++) {
                widgets[i] = widgetDefs[i].widget;
            }
        }
        return widgets;
    },
    afterInsert: function (document) {
        var node = this.getNode(document);

        this._added = true;
        raptorPubsub.emit('raptor-renderer/renderedToDOM', {
            node: node,
            context: this.out,
            out: this.out,
            document: node.ownerDocument
        });    // NOTE: This will trigger widgets to be initialized if there were any

        return this;
    },
    appendTo: function (referenceEl) {
        dom.appendTo(this.getNode(referenceEl.ownerDocument), referenceEl);
        return this.afterInsert();
    },
    replace: function (referenceEl) {
        dom.replace(this.getNode(referenceEl.ownerDocument), referenceEl);
        return this.afterInsert();
    },
    replaceChildrenOf: function (referenceEl) {
        dom.replaceChildrenOf(this.getNode(referenceEl.ownerDocument), referenceEl);
        return this.afterInsert();
    },
    insertBefore: function (referenceEl) {
        dom.insertBefore(this.getNode(referenceEl.ownerDocument), referenceEl);
        return this.afterInsert();
    },
    insertAfter: function (referenceEl) {
        dom.insertAfter(this.getNode(referenceEl.ownerDocument), referenceEl);
        return this.afterInsert();
    },
    prependTo: function (referenceEl) {
        dom.prependTo(this.getNode(referenceEl.ownerDocument), referenceEl);
        return this.afterInsert();
    },
    getNode: function (document) {
        var node = this._node;
        var curEl;
        var newBodyEl;
        document = document || window.document;
        if (node === undefined) {
            if (this.html) {
                newBodyEl = document.createElement('body');
                newBodyEl.innerHTML = this.html;
                if (newBodyEl.childNodes.length == 1) {
                    // If the rendered component resulted in a single node then just use that node
                    node = newBodyEl.childNodes[0];
                } else {
                    // Otherwise, wrap the nodes in a document fragment node
                    node = document.createDocumentFragment();
                    while ((curEl = newBodyEl.firstChild)) {
                        node.appendChild(curEl);
                    }
                }
            } else {
                // empty HTML so use empty document fragment (so that we're returning a valid DOM node)
                node = document.createDocumentFragment();
            }
            this._node = node;
        }
        return node;
    },
    toString: function() {
        return this.html;
    }
};
module.exports = RenderResult;
});
$_mod.installed("raptor-renderer$1.4.6", "raptor-util", "1.1.1");
$_mod.def("/raptor-util$1.1.1/extend", function(require, exports, module, __filename, __dirname) { module.exports = function extend(target, source) { //A simple function to copy properties from one object to another
    if (!target) { //Check if a target was provided, otherwise create a new empty object to return
        target = {};
    }

    if (source) {
        for (var propName in source) {
            if (source.hasOwnProperty(propName)) { //Only look at source properties that are not inherited
                target[propName] = source[propName]; //Copy the property
            }
        }
    }

    return target;
};
});
$_mod.def("/raptor-renderer$1.4.6/lib/raptor-renderer", function(require, exports, module, __filename, __dirname) { 'use strict';
var asyncWriter = require('/async-writer$2.1.2/src/index'/*'async-writer'*/);
var RenderResult = require('/raptor-renderer$1.4.6/lib/RenderResult-browser'/*'./RenderResult'*/);
var extend = require('/raptor-util$1.1.1/extend'/*'raptor-util/extend'*/);

 function createRenderFunc(renderer) {
    return function render(input, out, callback) {
        // NOTE: we avoid using Function.apply for performance reasons
        switch (arguments.length) {
            case 0:
                // Arguments: input
                return exports.render(renderer);
            case 1:
                // Arguments: input
                return exports.render(renderer, input);
            case 2:
                // Arguments: input, out|callback
                return exports.render(renderer, input, out);
            case 3:
                // Arguments: input, out, callback
                return exports.render(renderer, input, out, callback);
            default:
                throw new Error('Illegal arguments');
        }
    };
}

exports.render = function (renderer, input, out) {
    var numArgs = arguments.length;
    // The renderer function is required so only set the callback if we have more
    // than one argument
    var callback;
    if (numArgs > 1) {
        callback = arguments[numArgs - 1];
    }

    var actualOut = out;
    var actualData = input || {};
    var shouldEnd = false;

    if (typeof callback === 'function') {
        // found a callback
        if (numArgs === 3) {
            actualOut = asyncWriter.create();
            shouldEnd = true;
        }
    } else {
        callback = null;
        if (!actualOut) {
            actualOut = asyncWriter.create();
            shouldEnd = true;
        }
    }

    var $global = actualData.$global;
    if ($global) {
        extend(actualOut.global, $global);
        delete actualData.$global;
    }

    if (typeof renderer !== 'function') {
        var renderFunc = renderer.renderer || renderer.render || renderer.process;

        if (typeof renderFunc !== 'function') {
            throw new Error('Invalid renderer');
        }

        renderFunc.call(renderer, actualData, actualOut);
    } else {
        renderer(actualData, actualOut);
    }

    if (callback) {
        actualOut
            .on('finish', function() {
                callback(null, new RenderResult(actualOut.getOutput(), actualOut));
            })
            .on('error', callback);
        if(shouldEnd) actualOut.end();
    } else {
        // NOTE: If no callback is provided then it is assumed that no asynchronous rendering occurred.
        //       Might want to add some checks in the future to ensure the actualOut is really done
        if(shouldEnd) actualOut.end();
        return new RenderResult(actualOut.getOutput(), actualOut);
    }
};

exports.renderable = function(target, renderer) {
    target.renderer = renderer;
    target.render = createRenderFunc(renderer);
};

exports.createRenderFunc = createRenderFunc;

});
$_mod.installed("marko-widgets$6.4.1", "raptor-async", "1.1.3");
$_mod.def("/raptor-async$1.1.3/AsyncValue", function(require, exports, module, __filename, __dirname) { var process=require("process"); // NOTE: Be careful if these numeric values are changed
//       because some of the logic is based on an assumed
//       sequencial order.
var STATE_INITIAL = 0;
var STATE_LOADING = 1;
var STATE_RESOLVED = 2;
var STATE_REJECTED = 3;

var now = Date.now || function() {
    return (new Date()).getTime();
};

function AsyncValue(options) {

    /**
     * The data that was provided via call to resolve(data).
     * This property is assumed to be public and available for inspection.
     */
    this.data = undefined;

    /**
     * The data that was provided via call to reject(err)
     * This property is assumed to be public and available for inspection.
     */
    this.error = undefined;

    /**
     * The queue of callbacks that are waiting for data
     */
    this._callbacks = undefined;

    /**
     * The state of the data holder (STATE_INITIAL, STATE_RESOLVED, or STATE_REJECTED)
     */
    this._state = STATE_INITIAL;

    /**
     * The point in time when this data provider was settled.
     */
    this._timestamp = undefined;

    if (options) {
        /**
         * An optional function that will be invoked to load the data
         * the first time data is requested.
         */
        this._loader = options.loader;

        /**
         * The "this" object that will be used when invoking callbacks and loaders.
         * NOTE: Some callbacks may have provided their own scope and that will be used
         *       instead of this scope.
         */
        this._scope = options.scope;

        /**
         * Time-to-live (in milliseconds).
         * A data holder can automatically invalidate it's held data or error after a preset period
         * of time. This should be used in combination of a loader. This is helpful in cases
         * where a data holder is used for caching purposes.
         */
        this._ttl = options.ttl || undefined;
    }
}

function notifyCallbacks(dataHolder, err, data) {
    var callbacks = dataHolder._callbacks;
    if (callbacks !== undefined) {
        // clear out the registered callbacks (we still have reference to the original value)
        dataHolder._callbacks = undefined;

        // invoke all of the callbacks and use their scope
        for (var i = 0; i < callbacks.length; i++) {
            // each callback is actually an object with "scope and "callback" properties
            var callbackInfo = callbacks[i];
            callbackInfo.callback.call(callbackInfo.scope, err, data);
        }
    }
}

function invokeLoader(dataProvider) {
    // transition to the loading state
    dataProvider._state = STATE_LOADING;

    // call the loader
    dataProvider._loader.call(dataProvider._scope || dataProvider, function (err, data) {
        if (err) {
            // reject with error
            dataProvider.reject(err);
        } else {
            // resolve with data
            dataProvider.resolve(data);
        }
    });
}

function addCallback(dataProvider, callback, scope) {
    if (dataProvider._callbacks === undefined) {
        dataProvider._callbacks = [];
    }

    dataProvider._callbacks.push({
        callback: callback,
        scope: scope || dataProvider._scope || dataProvider
    });
}

function isExpired(dataProvider) {
    var timeToLive = dataProvider._ttl;
    if ((timeToLive !== undefined) && ((now() - dataProvider._timestamp) > timeToLive)) {
        // unsettle the data holder if we find that it is expired
        dataProvider.unsettle();
        return true;
    } else {
        return false;
    }
}

AsyncValue.prototype = {

    /**
     * Has resolved function been called?
     */
    isResolved: function() {

        return (this._state === STATE_RESOLVED) && !isExpired(this);
    },

    /**
     * Has reject function been called?
     */
    isRejected: function() {
        return (this._state === STATE_REJECTED) && !isExpired(this);
    },

    /**
     * Is there an outstanding request to load data via loader?
     */
    isLoading: function() {
        return (this._state === STATE_LOADING);
    },

    /**
     * Has reject or resolve been called?
     *
     * This method will also do time-to-live checks if applicable.
     * If this data holder was settled prior to calling this method
     * but the time-to-live has been exceeded then the state will
     * returned to unsettled state and this method will return false.
     */
    isSettled: function() {
        // are we in STATE_RESOLVED or STATE_REJECTED?
        return (this._state > STATE_LOADING) && !isExpired(this);
    },

    /**
     * Trigger loading data if we have a loader and we are not already loading.
     * Even if a data holder is in a resolved or rejected state, load can be called
     * to get a new value.
     *
     * @return the resolved data (if loader synchronously calls resolve)
     */
    load: function(callback, scope) {
        if (!this._loader) {
            throw new Error('Cannot call load when loader is not configured');
        }

        if (this.isSettled()) {
            // clear out the old data and error
            this.unsettle();
        }

        // callback is optional for load call
        if (callback) {
            addCallback(this, callback, scope);
        }

        if (this._state !== STATE_LOADING) {
            // trigger the loading
            invokeLoader(this);
        }

        return this.data;
    },

    /**
     * Adds a callback to the queue. If there is not a pending request to load data
     * and we have a "loader" then we will use that loader to request the data.
     * The given callback will be invoked when there is an error or resolved data
     * available.
     */
    done: function (callback, scope) {
        if (!callback || (callback.constructor !== Function)) {
            throw new Error('Invalid callback: ' + callback);
        }

        // Do we already have data or error?
        if (this.isSettled()) {
            // invoke the callback immediately
            return callback.call(scope || this._scope || this, this.error, this.data);
        }

        if (process.domain) {
            callback = process.domain.bind(callback);
        }

        addCallback(this, callback, scope);

        // only invoke loader if we have loader and we are not currently loading value
        if (this._loader && (this._state !== STATE_LOADING)) {
            invokeLoader(this);
        }
    },

    /**
     * This method will trigger any callbacks to be notified of rejection (error).
     * If this data holder has a loader then the data holder will be returned to
     * its initial state so that any future requests to load data will trigger a
     * new load call.
     */
    reject: function(err) {
        // remember the error
        this.error = err;

        // clear out the data
        this.data = undefined;

        // record timestamp of when we were settled
        if (this._ttl !== undefined) {
            this._timestamp = now();
        }

        // Go to the rejected state if we don't have a loader.
        // If we do have a loader then return to the initial state
        // (we do this so that next call to done() will trigger load
        // again in case the error was transient).
        this._state = this._loader ? STATE_INITIAL : STATE_REJECTED;

        // always notify callbacks regardless of whether or not we return to the initial state
        notifyCallbacks(this, err, null);
    },

    /**
     * This method will trigger any callbacks to be notified of data.
     */
    resolve: function (data) {
        // clear out the error
        this.error = undefined;

        // remember the state
        this.data = data;

        // record timestamp of when we were settled
        if (this._ttl !== undefined) {
            this._timestamp = now();
        }

        // go to the resolved state
        this._state = STATE_RESOLVED;

        // notify callbacks
        notifyCallbacks(this, null, data);
    },

    /**
     * Clear out data or error and return this data holder to initial state.
     * If the are any pending callbacks then those will be removed and not invoked.
     */
    reset: function () {
        // return to the initial state and clear error and data
        this.unsettle();

        // remove any callbacks
        this.callbacks = undefined;
    },

    /**
     * Return to the initial state and clear stored error or data.
     * If there are any callbacks still waiting for data, then those
     * will be retained.
     */
    unsettle: function () {
        // return to initial state
        this._state = STATE_INITIAL;

        // reset error value
        this.error = undefined;

        // reset data value
        this.data = undefined;

        // clear the timestamp of when we were settled
        this._timestamp = undefined;
    }
};

AsyncValue.create = function(config) {
    return new AsyncValue(config);
};

module.exports = AsyncValue;

});
$_mod.installed("marko-widgets$6.4.1", "marko", "3.12.1");
$_mod.main("/marko$3.12.1", "runtime/marko-runtime");
$_mod.installed("marko$3.12.1", "async-writer", "2.1.2");
$_mod.installed("marko$3.12.1", "raptor-util", "2.0.0");
$_mod.def("/raptor-util$2.0.0/escapeXml", function(require, exports, module, __filename, __dirname) { var elTest = /[&<]/;
var elTestReplace = /[&<]/g;
var attrTest = /[&<>\"\'\n]/;
var attrReplace = /[&<>\"\'\n]/g;
var replacements = {
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    '"': '&quot;',
    '\'': '&#39;',
    '\n': '&#10;' //Preserve new lines so that they don't get normalized as space
};

function replaceChar(match) {
    return replacements[match];
}

function escapeXml(str) {
    // check for most common case first
    if (typeof str === 'string') {
        return elTest.test(str) ? str.replace(elTestReplace, replaceChar) : str;
    }

    return (str == null) ? '' : str.toString();
}

function escapeXmlAttr(str) {
    if (typeof str === 'string') {
        return attrTest.test(str) ? str.replace(attrReplace, replaceChar) : str;
    }

    return (str == null) ? '' : str.toString();
}


module.exports = escapeXml;
escapeXml.attr = escapeXmlAttr;
});
$_mod.main("/marko$3.12.1/runtime", "marko-runtime");
$_mod.main("/marko$3.12.1/runtime/stream", "");
$_mod.remap("/marko$3.12.1/runtime/stream/index", "/marko$3.12.1/runtime/stream/index-browser");
$_mod.def("/marko$3.12.1/runtime/stream/index-browser", function(require, exports, module, __filename, __dirname) { var stream;
var STREAM = 'stream';

var streamPath;
try {
    streamPath = require.resolve(STREAM);
} catch(e) {}

if (streamPath) {
    stream = require(streamPath);
}

module.exports = stream;
});
$_mod.main("/marko$3.12.1/runtime/loader", "");
$_mod.remap("/marko$3.12.1/runtime/loader/index", "/marko$3.12.1/runtime/loader/index-browser");
$_mod.def("/marko$3.12.1/runtime/loader/index-browser", function(require, exports, module, __filename, __dirname) { /*
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

module.exports = function load(templatePath) {
    // We make the assumption that the template path is a
    // fully resolved module path and that the module exists
    // as a CommonJS module
    return require(templatePath);
};
});
$_mod.def("/raptor-util$2.0.0/attr", function(require, exports, module, __filename, __dirname) { var escapeXmlAttr = require('/raptor-util$2.0.0/escapeXml'/*'./escapeXml'*/).attr;

module.exports = function(name, value, escapeXml) {
    if (value === true) {
        value = '';
    } else if (value == null || value === false) {
        return '';
    } else {
        value = '="' + (escapeXml === false ? value : escapeXmlAttr(value)) + '"';
    }
    return ' ' + name + value;
};

});
$_mod.def("/marko$3.12.1/helpers/notEmpty", function(require, exports, module, __filename, __dirname) { module.exports = function notEmpty(o) {
    if (o == null) {
        return false;
    } else if (Array.isArray(o)) {
        return !!o.length;
    } else if (o === '') {
        return false;
    }

    return true;
};
});
$_mod.def("/marko$3.12.1/runtime/deprecate", function(require, exports, module, __filename, __dirname) { var logger = typeof console !== 'undefined' && console.warn && console;

module.exports = function(o, methodName, message) {
    if (!logger) {
        return;
    }

    var originalMethod = o[methodName];

    var maxWarn = 20;
    var currentWarn = 0;

    o[methodName] = function() {
        if (currentWarn < maxWarn) {
            if (++currentWarn === maxWarn) {
                o[methodName] = originalMethod;
            }
            logger.warn(message, 'Stack: ' + new Error().stack);
        }

        return originalMethod.apply(o, arguments);
    };
};
});
$_mod.def("/marko$3.12.1/runtime/helpers", function(require, exports, module, __filename, __dirname) { /*
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

'use strict';
var escapeXml = require('/raptor-util$2.0.0/escapeXml'/*'raptor-util/escapeXml'*/);
var escapeXmlAttr = escapeXml.attr;
var runtime = require('/marko$3.12.1/runtime/marko-runtime'/*'./'*/); // Circular dependency, but that is okay
var attr = require('/raptor-util$2.0.0/attr'/*'raptor-util/attr'*/);
var notEmpty = require('/marko$3.12.1/helpers/notEmpty'/*'../helpers/notEmpty'*/);

var isArray = Array.isArray;
var STYLE_ATTR = 'style';
var CLASS_ATTR = 'class';
var escapeEndingScriptTagRegExp = /<\//g;

function classListHelper(arg, classNames) {
    var len;

    if (arg) {
        if (typeof arg === 'string') {
            classNames.push(arg);
        } else if (typeof (len = arg.length) === 'number') {
            for (var i=0; i<len; i++) {
                classListHelper(arg[i], classNames);
            }
        } else if (typeof arg === 'object') {
            for (var name in arg) {
                if (arg.hasOwnProperty(name)) {
                    var value = arg[name];
                    if (value) {
                        classNames.push(name);
                    }
                }
            }
        }
    }
}

function classList(classList) {
    var classNames = [];
    classListHelper(classList, classNames);
    return classNames.join(' ');
}

function createDeferredRenderer(handler) {
    function deferredRenderer(input, out) {
        deferredRenderer.renderer(input, out);
    }

    // This is the initial function that will do the rendering. We replace
    // the renderer with the actual renderer func on the first render
    deferredRenderer.renderer = function(input, out) {
        var rendererFunc = handler.renderer || handler.render;
        if (typeof rendererFunc !== 'function') {
            throw new Error('Invalid tag handler: ' + handler);
        }
        // Use the actual renderer from now on
        deferredRenderer.renderer = rendererFunc;
        rendererFunc(input, out);
    };

    return deferredRenderer;
}

function resolveRenderer(handler) {
    var renderer = handler.renderer;

    if (renderer) {
        return renderer;
    }

    if (typeof handler === 'function') {
        return handler;
    }

    if (typeof (renderer = handler.render) === 'function') {
        return renderer;
    }

    // If the user code has a circular function then the renderer function
    // may not be available on the module. Since we can't get a reference
    // to the actual renderer(input, out) function right now we lazily
    // try to get access to it later.
    return createDeferredRenderer(handler);
}

function LoopStatus(getLength, isLast, isFirst, getIndex) {
    this.getLength = getLength;
    this.isLast = isLast;
    this.isFirst = isFirst;
    this.getIndex = getIndex;
}

module.exports = exports = {
    /**
     * Internal helper method to prevent null/undefined from being written out
     * when writing text that resolves to null/undefined
     * @private
     */
    s: function(str) {
        return (str == null) ? '' : str;
    },
    /**
     * Internal helper method to handle loops with a status variable
     * @private
     */
    fv: function (array, callback) {
        if (!array) {
            return;
        }
        if (!array.forEach) {
            array = [array];
        }
        var i = 0;
        var len = array.length;
        var loopStatus = new LoopStatus(
                function getLength() {
                    return len;
                },
                function isLast() {
                    return i === len - 1;
                },
                function isFirst() {
                    return i === 0;
                },
                function getIndex() {
                    return i;
                });

        for (; i < len; i++) {
            var o = array[i];
            callback(o, loopStatus);
        }
    },

    /**
     * Internal helper method to handle loops without a status variable
     * @private
     */
    f: function forEach(array, callback) {
        if (isArray(array)) {
            for (var i=0; i<array.length; i++) {
                callback(array[i]);
            }
        } else if (typeof array === 'function') {
            // Also allow the first argument to be a custom iterator function
            array(callback);
        }
    },
    /**
     * Internal helper method for looping over the properties of any object
     * @private
     */
    fp: function (o, func) {
        if (!o) {
            return;
        }
        for (var k in o) {
            if (o.hasOwnProperty(k)) {
                func(k, o[k]);
            }
        }
    },
    /**
     * Internal method to check if an object/array is empty
     * @private
     */
    e: function empty(o) {
        return !notEmpty(o);
    },
    /**
     * Internal method to check if an object/array is not empty
     * @private
     */
    ne: notEmpty,
    /**
     * Internal method to escape special XML characters
     * @private
     */
    x: escapeXml,
    /**
     * Internal method to escape special XML characters within an attribute
     * @private
     */
    xa: escapeXmlAttr,

    /**
     * Escapes the '</' sequence in the body of a <script> body to avoid the `<script>` being
     * ended prematurely.
     *
     * For example:
     * var evil = {
     * 	name:  '</script><script>alert(1)</script>'
     * };
     *
     * <script>var foo = ${JSON.stringify(evil)}</script>
     *
     * Without escaping the ending '</script>' sequence the opening <script> tag would be
     * prematurely ended and a new script tag could then be started that could then execute
     * arbitrary code.
     */
    xs: function(val) {
        return (typeof val === 'string') ? val.replace(escapeEndingScriptTagRegExp, '\\u003C/') : val;
    },

    /**
     * Internal method to render a single HTML attribute
     * @private
     */
    a: attr,

    /**
     * Internal method to render multiple HTML attributes based on the properties of an object
     * @private
     */
    as: function(arg) {
        if (typeof arg === 'object') {
            var out = '';
            for (var attrName in arg) {
                out += attr(attrName, arg[attrName]);
            }
            return out;
        } else if (typeof arg === 'string') {
            return arg;
        }
        return '';
    },

    /**
     * Internal helper method to handle the "style" attribute. The value can either
     * be a string or an object with style propertes. For example:
     *
     * sa('color: red; font-weight: bold') ==> ' style="color: red; font-weight: bold"'
     * sa({color: 'red', 'font-weight': 'bold'}) ==> ' style="color: red; font-weight: bold"'
     */
    sa: function(style) {
        if (!style) {
            return '';
        }

        if (typeof style === 'string') {
            return attr(STYLE_ATTR, style, false);
        } else if (typeof style === 'object') {
            var parts = [];
            for (var name in style) {
                if (style.hasOwnProperty(name)) {
                    var value = style[name];
                    if (value) {
                        parts.push(name + ':' + value);
                    }
                }
            }
            return parts ? attr(STYLE_ATTR, parts.join(';'), false) : '';
        } else {
            return '';
        }
    },

    /**
     * Internal helper method to handle the "class" attribute. The value can either
     * be a string, an array or an object. For example:
     *
     * ca('foo bar') ==> ' class="foo bar"'
     * ca({foo: true, bar: false, baz: true}) ==> ' class="foo baz"'
     * ca(['foo', 'bar']) ==> ' class="foo bar"'
     */
    ca: function(classNames) {
        if (!classNames) {
            return '';
        }

        if (typeof classNames === 'string') {
            return attr(CLASS_ATTR, classNames, false);
        } else {
            return attr(CLASS_ATTR, classList(classNames), false);
        }
    },

    /**
     * Loads a template (__helpers.l --> loadTemplate(path))
     */
    l: function(path) {
        if (typeof path === 'string') {
            return runtime.load(path);
        } else {
            // Assume it is already a pre-loaded template
            return path;
        }
    },

    // ----------------------------------
    // The helpers listed below require an out
    // ----------------------------------


    /**
     * Invoke a tag handler render function
     */
    t: function (renderer, targetProperty, isRepeated, hasNestedTags) {
        if (renderer) {
            renderer = resolveRenderer(renderer);
        }

        if (targetProperty || hasNestedTags) {
            return function(input, out, parent, renderBody) {
                // Handle nested tags
                if (renderBody) {
                    renderBody(out, input);
                }

                if (targetProperty) {
                    // If we are nested tag then we do not have a renderer
                    if (isRepeated) {
                        var existingArray = parent[targetProperty];
                        if (existingArray) {
                            existingArray.push(input);
                        } else {
                            parent[targetProperty] = [input];
                        }
                    } else {
                        parent[targetProperty] = input;
                    }
                } else {
                    // We are a tag with nested tags, but we have already found
                    // our nested tags by rendering the body
                    renderer(input, out);
                }
            };
        } else {
            return renderer;
        }
    },

    /**
     * Internal method to handle includes/partials
     * @private
     */
    i: function(out, template, data) {
        if (!template) {
            return;
        }

        if (typeof template.render === 'function') {
            template.render(data, out);
        } else {
            throw new Error('Invalid template: ' + template);
        }

        return this;
    },

    /**
     * Merges object properties
     * @param  {[type]} object [description]
     * @param  {[type]} source [description]
     * @return {[type]}        [description]
     */
    m: function(into, source) {
        for (var k in source) {
            if (source.hasOwnProperty(k) && !into.hasOwnProperty(k)) {
                into[k] = source[k];
            }
        }
        return into;
    },

    /**
     * classList(a, b, c, ...)
     * Joines a list of class names with spaces. Empty class names are omitted.
     *
     * classList('a', undefined, 'b') --> 'a b'
     *
     */
    cl: function() {
        return classList(arguments);
    }
};

var deprecate = require('/marko$3.12.1/runtime/deprecate'/*'./deprecate'*/);
var emptyNotEmptyDeprecationUrl = 'https://github.com/marko-js/marko/issues/357';
deprecate(exports, 'e', 'empty() helper is deprecated. See: ' + emptyNotEmptyDeprecationUrl);
deprecate(exports, 'ne', 'notEmpty() helper is deprecated. See: ' + emptyNotEmptyDeprecationUrl);
});
$_mod.def("/marko$3.12.1/runtime/marko-runtime", function(require, exports, module, __filename, __dirname) { /*
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
 * This module provides the lightweight runtime for loading and rendering
 * templates. The compilation is handled by code that is part of the
 * [marko/compiler](https://github.com/raptorjs/marko/tree/master/compiler)
 * module. If rendering a template on the client, only the runtime is needed
 * on the client and not the compiler
 */

// async-writer provides all of the magic to support asynchronous
// rendering to a stream

'use strict';
/**
 * Method is for internal usage only. This method
 * is invoked by code in a compiled Marko template and
 * it is used to create a new Template instance.
 * @private
 */
exports.c = function createTemplate(path) {
    return new Template(path);
};

var BUFFER_OPTIONS = { buffer: true };

var asyncWriter = require('/async-writer$2.1.2/src/index'/*'async-writer'*/);

// helpers provide a core set of various utility methods
// that are available in every template (empty, notEmpty, etc.)
var helpers = require('/marko$3.12.1/runtime/helpers'/*'./helpers'*/);

var loader;

// If the optional "stream" module is available
// then Readable will be a readable stream
var Readable;

var AsyncStream = asyncWriter.AsyncStream;
var extend = require('/raptor-util$2.0.0/extend'/*'raptor-util/extend'*/);



exports.AsyncStream = AsyncStream;

var stream = require('/marko$3.12.1/runtime/stream/index-browser'/*'./stream'*/);

function renderCallback(renderFunc, data, globalData, callback) {
    var out = new AsyncStream();
    if (globalData) {
        extend(out.global, globalData);
    }

    renderFunc(data, out);
    return out.end()
        .on('finish', function() {
            callback(null, out.getOutput(), out);
        })
        .once('error', callback);
}

function Template(path, func, options) {
    this.path = path;
    this._ = func;
    this._options = !options || options.buffer !== false ?
        BUFFER_OPTIONS : null;
}

Template.prototype = {
    /**
     * Internal method to initialize a loaded template with a
     * given create function that was generated by the compiler.
     * Warning: User code should not depend on this method.
     *
     * @private
     * @param  {Function(__helpers)} createFunc The function used to produce the render(data, out) function.
     */
    c: function(createFunc) {
        this._ = createFunc(helpers);
    },
    renderSync: function(data) {
        var localData = data || {};
        var out = new AsyncStream();
        out.sync();

        if (localData.$global) {
            out.global = extend(out.global, localData.$global);
            delete localData.$global;
        }

        this._(localData, out);
        return out.getOutput();
    },

    /**
     * Renders a template to either a stream (if the last
     * argument is a Stream instance) or
     * provides the output to a callback function (if the last
     * argument is a Function).
     *
     * Supported signatures:
     *
     * render(data, callback)
     * render(data, out)
     * render(data, stream)
     * render(data, out, callback)
     * render(data, stream, callback)
     *
     * @param  {Object} data The view model data for the template
     * @param  {AsyncStream} out A Stream or an AsyncStream instance
     * @param  {Function} callback A callback function
     * @return {AsyncStream} Returns the AsyncStream instance that the template is rendered to
     */
    render: function(data, out, callback) {
        var renderFunc = this._;
        var finalData;
        var globalData;
        if (data) {
            finalData = data;

            if ((globalData = data.$global)) {
                // We will *move* the "$global" property
                // into the "out.global" object
                delete data.$global;
            }
        } else {
            finalData = {};
        }

        if (typeof out === 'function') {
            // Short circuit for render(data, callback)
            return renderCallback(renderFunc, finalData, globalData, out);
        }

        // NOTE: We create new vars here to avoid a V8 de-optimization due
        //       to the following:
        //       Assignment to parameter in arguments object
        var finalOut = out;

        var shouldEnd = false;

        if (arguments.length === 3) {
            // render(data, out, callback)
            if (!finalOut || !finalOut.isAsyncStream) {
                finalOut = new AsyncStream(globalData, finalOut);
                shouldEnd = true;
            }

            finalOut
                .on('finish', function() {
                    callback(null, finalOut.getOutput(), finalOut);
                })
                .once('error', callback);
        } else if (!finalOut || !finalOut.isAsyncStream) {
            // Assume the "finalOut" is really a stream
            //
            // By default, we will buffer rendering to a stream to prevent
            // the response from being "too chunky".
            finalOut = asyncWriter.create(finalOut, this._options);

            if (globalData) {
                extend(finalOut.global, globalData);
            }

            shouldEnd = true;
        }

        // Invoke the compiled template's render function to have it
        // write out strings to the provided out.
        renderFunc(finalData, finalOut);

        // Automatically end output stream (the writer) if we
        // had to create an async writer (which might happen
        // if the caller did not provide a writer/out or the
        // writer/out was not an AsyncStream).
        //
        // If out parameter was originally an AsyncStream then
        // we assume that we are writing to output that was
        // created in the context of another rendering job.
        return shouldEnd ? finalOut.end() : finalOut;
    },
    stream: function(data) {
        if (!stream) {
            throw new Error('Module not found: stream');
        }

        return new Readable(this, data, this._options);
    }
};

if (stream) {
    Readable = function(template, data, options) {
        Readable.$super.call(this);
        this._t = template;
        this._d = data;
        this._options = options;
        this._rendered = false;
    };

    Readable.prototype = {
        write: function(data) {
            if (data != null) {
                this.push(data);
            }
        },
        end: function() {
            this.push(null);
        },
        _read: function() {
            if (this._rendered) {
                return;
            }

            this._rendered = true;

            var template = this._t;
            var data = this._d;
            var options = this._options;

            var globalData = data && data.$global;
            var shouldBuffer = options && options.buffer !== false;

            var out = new AsyncStream(globalData, this, null, shouldBuffer);

            template.render(data, out);
            out.end();
        }
    };

    require('/raptor-util$2.0.0/inherit'/*'raptor-util/inherit'*/)(Readable, stream.Readable);
}

function createRenderProxy(template) {
    return function(data, out) {
        template._(data, out);
    };
}

function initTemplate(rawTemplate, templatePath) {
    if (rawTemplate.render) {
        return rawTemplate;
    }

    var createFunc = rawTemplate.create || rawTemplate;

    var template = createFunc.loaded;
    if (!template) {
        template = createFunc.loaded = new Template(templatePath);
        template.c(createFunc);
    }
    return template;
}

function load(templatePath, templateSrc, options) {
    if (!templatePath) {
        throw new Error('"templatePath" is required');
    }

    if (arguments.length === 1) {
        // templateSrc and options not provided
    } else if (arguments.length === 2) {
        // see if second argument is templateSrc (a String)
        // or options (an Object)
        var lastArg = arguments[arguments.length - 1];
        if (typeof lastArg !== 'string') {
            options = arguments[1];
            templateSrc = undefined;
        }
    } else if (arguments.length === 3) {
        // assume function called according to function signature
    } else {
        throw new Error('Illegal arguments');
    }

    var template;

    if (typeof templatePath === 'string') {
        template = initTemplate(loader(templatePath, templateSrc, options), templatePath);
    } else if (templatePath.render) {
        template = templatePath;
    } else {
        template = initTemplate(templatePath);
    }

    if (options && (options.buffer != null)) {
        template = new Template(
            template.path,
            createRenderProxy(template),
            options);
    }

    return template;
}

exports.load = load;

exports.createWriter = function(writer) {
    return new AsyncStream(null, writer);
};

exports.helpers = helpers;

exports.Template = Template;

// The loader is used to load templates that have not already been
// loaded and cached. On the server, the loader will use
// the compiler to compile the template and then load the generated
// module file using the Node.js module loader
loader = require('/marko$3.12.1/runtime/loader/index-browser'/*'./loader'*/);

});
$_mod.installed("marko-widgets$6.4.1", "listener-tracker", "1.2.0");
$_mod.main("/listener-tracker$1.2.0", "lib/listener-tracker");
$_mod.def("/listener-tracker$1.2.0/lib/listener-tracker", function(require, exports, module, __filename, __dirname) { var INDEX_EVENT = 0;
var INDEX_USER_LISTENER = 1;
var INDEX_WRAPPED_LISTENER = 2;
var DESTROY = "destroy";

function isNonEventEmitter(target) {
  return !target.once;
}

function EventEmitterWrapper(target) {
    this._target = target;
    this._listeners = [];
    this._subscribeTo = null;
}

EventEmitterWrapper.prototype = {
    _remove: function(test, testWrapped) {
        var target = this._target;
        var listeners = this._listeners;

        this._listeners = listeners.filter(function(curListener) {
            var curEvent = curListener[INDEX_EVENT];
            var curListenerFunc = curListener[INDEX_USER_LISTENER];
            var curWrappedListenerFunc = curListener[INDEX_WRAPPED_LISTENER];

            if (testWrapped) {
                // If the user used `once` to attach an event listener then we had to
                // wrap their listener function with a new function that does some extra
                // cleanup to avoid a memory leak. If the `testWrapped` flag is set to true
                // then we are attempting to remove based on a function that we had to
                // wrap (not the user listener function)
                if (curWrappedListenerFunc && test(curEvent, curWrappedListenerFunc)) {
                    target.removeListener(curEvent, curWrappedListenerFunc);

                    return false;
                }
            } else if (test(curEvent, curListenerFunc)) {
                // If the listener function was wrapped due to it being a `once` listener
                // then we should remove from the target EventEmitter using wrapped
                // listener function. Otherwise, we remove the listener using the user-provided
                // listener function.
                target.removeListener(curEvent, curWrappedListenerFunc || curListenerFunc);

                return false;
            }

            return true;
        });

        // Fixes https://github.com/raptorjs/listener-tracker/issues/2
        // If all of the listeners stored with a wrapped EventEmitter
        // have been removed then we should unregister the wrapped
        // EventEmitter in the parent SubscriptionTracker
        var subscribeTo = this._subscribeTo;

        if (this._listeners.length === 0 && subscribeTo) {
            var self = this;
            var subscribeToList = subscribeTo._subscribeToList;
            subscribeTo._subscribeToList = subscribeToList.filter(function(cur) {
                return cur !== self;
            });
        }
    },

    on: function(event, listener) {
        this._target.on(event, listener);
        this._listeners.push([event, listener]);
        return this;
    },

    once: function(event, listener) {
        var self = this;

        // Handling a `once` event listener is a little tricky since we need to also
        // do our own cleanup if the `once` event is emitted. Therefore, we need
        // to wrap the user's listener function with our own listener function.
        var wrappedListener = function() {
            self._remove(function(event, listenerFunc) {
                return wrappedListener === listenerFunc;
            }, true /* We are removing the wrapped listener */);

            listener.apply(this, arguments);
        };

        this._target.once(event, wrappedListener);
        this._listeners.push([event, listener, wrappedListener]);
        return this;
    },

    removeListener: function(event, listener) {
        if (typeof event === 'function') {
            listener = event;
            event = null;
        }

        if (listener && event) {
            this._remove(function(curEvent, curListener) {
                return event === curEvent && listener === curListener;
            });
        } else if (listener) {
            this._remove(function(curEvent, curListener) {
                return listener === curListener;
            });
        } else if (event) {
            this.removeAllListeners(event);
        }

        return this;
    },

    removeAllListeners: function(event) {

        var listeners = this._listeners;
        var target = this._target;

        if (event) {
            this._remove(function(curEvent, curListener) {
                return event === curEvent;
            });
        } else {
            for (var i = listeners.length - 1; i >= 0; i--) {
                var cur = listeners[i];
                target.removeListener(cur[INDEX_EVENT], cur[INDEX_USER_LISTENER]);
            }
            this._listeners.length = 0;
        }

        return this;
    }
};

EventEmitterWrapper.prototype.addListener = EventEmitterWrapper.prototype.on;

function EventEmitterAdapter(target) {
    this._target = target;
}

EventEmitterAdapter.prototype = {
    on: function(event, listener) {
        this._target.addEventListener(event, listener);
        return this;
    },

    once: function(event, listener) {
        var self = this;

        // need to save this so we can remove it below
        var onceListener = function() {
          self._target.removeEventListener(event, onceListener);
          listener();
        };
        this._target.addEventListener(event, onceListener);
        return this;
    },

    removeListener: function(event, listener) {
        this._target.removeEventListener(event, listener);
        return this;
    }
};

function SubscriptionTracker() {
    this._subscribeToList = [];
}

SubscriptionTracker.prototype = {

    subscribeTo: function(target, options) {
        var addDestroyListener = !options || options.addDestroyListener !== false;
        var wrapper;
        var nonEE;
        var subscribeToList = this._subscribeToList;

        for (var i=0, len=subscribeToList.length; i<len; i++) {
            var cur = subscribeToList[i];
            if (cur._target === target) {
                wrapper = cur;
                break;
            }
        }

        if (!wrapper) {
            if (isNonEventEmitter(target)) {
              nonEE = new EventEmitterAdapter(target);
            }

            wrapper = new EventEmitterWrapper(nonEE || target);
            if (addDestroyListener && !nonEE) {
                wrapper.once(DESTROY, function() {
                    wrapper.removeAllListeners();

                    for (var i = subscribeToList.length - 1; i >= 0; i--) {
                        if (subscribeToList[i]._target === target) {
                            subscribeToList.splice(i, 1);
                            break;
                        }
                    }
                });
            }

            // Store a reference to the parent SubscriptionTracker so that we can do cleanup
            // if the EventEmitterWrapper instance becomes empty (i.e., no active listeners)
            wrapper._subscribeTo = this;
            subscribeToList.push(wrapper);
        }

        return wrapper;
    },

    removeAllListeners: function(target, event) {
        var subscribeToList = this._subscribeToList;
        var i;

        if (target) {
            for (i = subscribeToList.length - 1; i >= 0; i--) {
                var cur = subscribeToList[i];
                if (cur._target === target) {
                    cur.removeAllListeners(event);

                    if (!cur._listeners.length) {
                        // Do some cleanup if we removed all
                        // listeners for the target event emitter
                        subscribeToList.splice(i, 1);
                    }

                    break;
                }
            }
        } else {
            for (i = subscribeToList.length - 1; i >= 0; i--) {
                subscribeToList[i].removeAllListeners();
            }
            subscribeToList.length = 0;
        }
    }
};

exports.wrap = function(targetEventEmitter) {
    var nonEE;
    var wrapper;

    if (isNonEventEmitter(targetEventEmitter)) {
      nonEE = new EventEmitterAdapter(targetEventEmitter);
    }

    wrapper = new EventEmitterWrapper(nonEE || targetEventEmitter);
    if (!nonEE) {
      // we don't set this for non EE types
      targetEventEmitter.once(DESTROY, function() {
          wrapper._listeners.length = 0;
      });
    }

    return wrapper;
};

exports.createTracker = function() {
    return new SubscriptionTracker();
};

});
$_mod.def("/raptor-util$2.0.0/arrayFromArguments", function(require, exports, module, __filename, __dirname) { var slice = [].slice;

module.exports = function(args, startIndex) {
    if (!args) {
        return [];
    }
    
    if (startIndex) {
        return startIndex < args.length ? slice.call(args, startIndex) : [];
    }
    else
    {
        return slice.call(args);
    }
};
});
$_mod.installed("marko-widgets$6.4.1", "morphdom", "1.4.6");
$_mod.main("/morphdom$1.4.6", "lib/index");
$_mod.def("/morphdom$1.4.6/lib/index", function(require, exports, module, __filename, __dirname) { // Create a range object for efficently rendering strings to elements.
var range;

var testEl = (typeof document !== 'undefined') ?
    document.body || document.createElement('div') :
    {};

var XHTML = 'http://www.w3.org/1999/xhtml';
var ELEMENT_NODE = 1;
var TEXT_NODE = 3;
var COMMENT_NODE = 8;

// Fixes <https://github.com/patrick-steele-idem/morphdom/issues/32>
// (IE7+ support) <=IE7 does not support el.hasAttribute(name)
var hasAttributeNS;

if (testEl.hasAttributeNS) {
    hasAttributeNS = function(el, namespaceURI, name) {
        return el.hasAttributeNS(namespaceURI, name);
    };
} else if (testEl.hasAttribute) {
    hasAttributeNS = function(el, namespaceURI, name) {
        return el.hasAttribute(name);
    };
} else {
    hasAttributeNS = function(el, namespaceURI, name) {
        return !!el.getAttributeNode(name);
    };
}

function empty(o) {
    for (var k in o) {
        if (o.hasOwnProperty(k)) {
            return false;
        }
    }
    return true;
}

function toElement(str) {
    if (!range && document.createRange) {
        range = document.createRange();
        range.selectNode(document.body);
    }

    var fragment;
    if (range && range.createContextualFragment) {
        fragment = range.createContextualFragment(str);
    } else {
        fragment = document.createElement('body');
        fragment.innerHTML = str;
    }
    return fragment.childNodes[0];
}

var specialElHandlers = {
    /**
     * Needed for IE. Apparently IE doesn't think that "selected" is an
     * attribute when reading over the attributes using selectEl.attributes
     */
    OPTION: function(fromEl, toEl) {
        fromEl.selected = toEl.selected;
        if (fromEl.selected) {
            fromEl.setAttribute('selected', '');
        } else {
            fromEl.removeAttribute('selected', '');
        }
    },
    /**
     * The "value" attribute is special for the <input> element since it sets
     * the initial value. Changing the "value" attribute without changing the
     * "value" property will have no effect since it is only used to the set the
     * initial value.  Similar for the "checked" attribute, and "disabled".
     */
    INPUT: function(fromEl, toEl) {
        fromEl.checked = toEl.checked;
        if (fromEl.checked) {
            fromEl.setAttribute('checked', '');
        } else {
            fromEl.removeAttribute('checked');
        }

        if (fromEl.value !== toEl.value) {
            fromEl.value = toEl.value;
        }

        if (!hasAttributeNS(toEl, null, 'value')) {
            fromEl.removeAttribute('value');
        }

        fromEl.disabled = toEl.disabled;
        if (fromEl.disabled) {
            fromEl.setAttribute('disabled', '');
        } else {
            fromEl.removeAttribute('disabled');
        }
    },

    TEXTAREA: function(fromEl, toEl) {
        var newValue = toEl.value;
        if (fromEl.value !== newValue) {
            fromEl.value = newValue;
        }

        if (fromEl.firstChild) {
            fromEl.firstChild.nodeValue = newValue;
        }
    }
};

function noop() {}

/**
 * Returns true if two node's names and namespace URIs are the same.
 *
 * @param {Element} a
 * @param {Element} b
 * @return {boolean}
 */
var compareNodeNames = function(a, b) {
    return a.nodeName === b.nodeName &&
           a.namespaceURI === b.namespaceURI;
};

/**
 * Create an element, optionally with a known namespace URI.
 *
 * @param {string} name the element name, e.g. 'div' or 'svg'
 * @param {string} [namespaceURI] the element's namespace URI, i.e. the value of
 * its `xmlns` attribute or its inferred namespace.
 *
 * @return {Element}
 */
function createElementNS(name, namespaceURI) {
    return !namespaceURI || namespaceURI === XHTML ?
        document.createElement(name) :
        document.createElementNS(namespaceURI, name);
}

/**
 * Loop over all of the attributes on the target node and make sure the original
 * DOM node has the same attributes. If an attribute found on the original node
 * is not on the new node then remove it from the original node.
 *
 * @param  {Element} fromNode
 * @param  {Element} toNode
 */
function morphAttrs(fromNode, toNode) {
    var attrs = toNode.attributes;
    var i;
    var attr;
    var attrName;
    var attrNamespaceURI;
    var attrValue;
    var fromValue;

    for (i = attrs.length - 1; i >= 0; i--) {
        attr = attrs[i];
        attrName = attr.name;
        attrValue = attr.value;
        attrNamespaceURI = attr.namespaceURI;

        if (attrNamespaceURI) {
            attrName = attr.localName || attrName;
            fromValue = fromNode.getAttributeNS(attrNamespaceURI, attrName);
        } else {
            fromValue = fromNode.getAttribute(attrName);
        }

        if (fromValue !== attrValue) {
            if (attrNamespaceURI) {
                fromNode.setAttributeNS(attrNamespaceURI, attrName, attrValue);
            } else {
                fromNode.setAttribute(attrName, attrValue);
            }
        }
    }

    // Remove any extra attributes found on the original DOM element that
    // weren't found on the target element.
    attrs = fromNode.attributes;

    for (i = attrs.length - 1; i >= 0; i--) {
        attr = attrs[i];
        if (attr.specified !== false) {
            attrName = attr.name;
            attrNamespaceURI = attr.namespaceURI;

            if (!hasAttributeNS(toNode, attrNamespaceURI, attrNamespaceURI ? attrName = attr.localName || attrName : attrName)) {
                if (attrNamespaceURI) {
                    fromNode.removeAttributeNS(attrNamespaceURI, attr.localName);
                } else {
                    fromNode.removeAttribute(attrName);
                }
            }
        }
    }
}

/**
 * Copies the children of one DOM element to another DOM element
 */
function moveChildren(fromEl, toEl) {
    var curChild = fromEl.firstChild;
    while (curChild) {
        var nextChild = curChild.nextSibling;
        toEl.appendChild(curChild);
        curChild = nextChild;
    }
    return toEl;
}

function defaultGetNodeKey(node) {
    return node.id;
}

function morphdom(fromNode, toNode, options) {
    if (!options) {
        options = {};
    }

    if (typeof toNode === 'string') {
        if (fromNode.nodeName === '#document' || fromNode.nodeName === 'HTML') {
            var toNodeHtml = toNode;
            toNode = document.createElement('html');
            toNode.innerHTML = toNodeHtml;
        } else {
            toNode = toElement(toNode);
        }
    }

    // XXX optimization: if the nodes are equal, don't morph them
    /*
    if (fromNode.isEqualNode(toNode)) {
      return fromNode;
    }
    */

    var savedEls = {}; // Used to save off DOM elements with IDs
    var unmatchedEls = {};
    var getNodeKey = options.getNodeKey || defaultGetNodeKey;
    var onBeforeNodeAdded = options.onBeforeNodeAdded || noop;
    var onNodeAdded = options.onNodeAdded || noop;
    var onBeforeElUpdated = options.onBeforeElUpdated || options.onBeforeMorphEl || noop;
    var onElUpdated = options.onElUpdated || noop;
    var onBeforeNodeDiscarded = options.onBeforeNodeDiscarded || noop;
    var onNodeDiscarded = options.onNodeDiscarded || noop;
    var onBeforeElChildrenUpdated = options.onBeforeElChildrenUpdated || options.onBeforeMorphElChildren || noop;
    var childrenOnly = options.childrenOnly === true;
    var movedEls = [];

    function removeNodeHelper(node, nestedInSavedEl) {
        var id = getNodeKey(node);
        // If the node has an ID then save it off since we will want
        // to reuse it in case the target DOM tree has a DOM element
        // with the same ID
        if (id) {
            savedEls[id] = node;
        } else if (!nestedInSavedEl) {
            // If we are not nested in a saved element then we know that this node has been
            // completely discarded and will not exist in the final DOM.
            onNodeDiscarded(node);
        }

        if (node.nodeType === ELEMENT_NODE) {
            var curChild = node.firstChild;
            while (curChild) {
                removeNodeHelper(curChild, nestedInSavedEl || id);
                curChild = curChild.nextSibling;
            }
        }
    }

    function walkDiscardedChildNodes(node) {
        if (node.nodeType === ELEMENT_NODE) {
            var curChild = node.firstChild;
            while (curChild) {


                if (!getNodeKey(curChild)) {
                    // We only want to handle nodes that don't have an ID to avoid double
                    // walking the same saved element.

                    onNodeDiscarded(curChild);

                    // Walk recursively
                    walkDiscardedChildNodes(curChild);
                }

                curChild = curChild.nextSibling;
            }
        }
    }

    function removeNode(node, parentNode, alreadyVisited) {
        if (onBeforeNodeDiscarded(node) === false) {
            return;
        }

        parentNode.removeChild(node);
        if (alreadyVisited) {
            if (!getNodeKey(node)) {
                onNodeDiscarded(node);
                walkDiscardedChildNodes(node);
            }
        } else {
            removeNodeHelper(node);
        }
    }

    function morphEl(fromEl, toEl, alreadyVisited, childrenOnly) {
        var toElKey = getNodeKey(toEl);
        if (toElKey) {
            // If an element with an ID is being morphed then it is will be in the final
            // DOM so clear it out of the saved elements collection
            delete savedEls[toElKey];
        }

        if (!childrenOnly) {
            if (onBeforeElUpdated(fromEl, toEl) === false) {
                return;
            }

            morphAttrs(fromEl, toEl);
            onElUpdated(fromEl);

            if (onBeforeElChildrenUpdated(fromEl, toEl) === false) {
                return;
            }
        }

        if (fromEl.nodeName !== 'TEXTAREA') {
            var curToNodeChild = toEl.firstChild;
            var curFromNodeChild = fromEl.firstChild;
            var curToNodeId;

            var fromNextSibling;
            var toNextSibling;
            var savedEl;
            var unmatchedEl;

            outer: while (curToNodeChild) {
                toNextSibling = curToNodeChild.nextSibling;
                curToNodeId = getNodeKey(curToNodeChild);

                while (curFromNodeChild) {
                    var curFromNodeId = getNodeKey(curFromNodeChild);
                    fromNextSibling = curFromNodeChild.nextSibling;

                    if (!alreadyVisited) {
                        if (curFromNodeId && (unmatchedEl = unmatchedEls[curFromNodeId])) {
                            unmatchedEl.parentNode.replaceChild(curFromNodeChild, unmatchedEl);
                            morphEl(curFromNodeChild, unmatchedEl, alreadyVisited);
                            curFromNodeChild = fromNextSibling;
                            continue;
                        }
                    }

                    var curFromNodeType = curFromNodeChild.nodeType;

                    if (curFromNodeType === curToNodeChild.nodeType) {
                        var isCompatible = false;

                        // Both nodes being compared are Element nodes
                        if (curFromNodeType === ELEMENT_NODE) {
                            if (compareNodeNames(curFromNodeChild, curToNodeChild)) {
                                // We have compatible DOM elements
                                if (curFromNodeId || curToNodeId) {
                                    // If either DOM element has an ID then we
                                    // handle those differently since we want to
                                    // match up by ID
                                    if (curToNodeId === curFromNodeId) {
                                        isCompatible = true;
                                    }
                                } else {
                                    isCompatible = true;
                                }
                            }

                            if (isCompatible) {
                                // We found compatible DOM elements so transform
                                // the current "from" node to match the current
                                // target DOM node.
                                morphEl(curFromNodeChild, curToNodeChild, alreadyVisited);
                            }
                        // Both nodes being compared are Text or Comment nodes
                    } else if (curFromNodeType === TEXT_NODE || curFromNodeType == COMMENT_NODE) {
                            isCompatible = true;
                            // Simply update nodeValue on the original node to
                            // change the text value
                            curFromNodeChild.nodeValue = curToNodeChild.nodeValue;
                        }

                        if (isCompatible) {
                            curToNodeChild = toNextSibling;
                            curFromNodeChild = fromNextSibling;
                            continue outer;
                        }
                    }

                    // No compatible match so remove the old node from the DOM
                    // and continue trying to find a match in the original DOM
                    removeNode(curFromNodeChild, fromEl, alreadyVisited);
                    curFromNodeChild = fromNextSibling;
                }

                if (curToNodeId) {
                    if ((savedEl = savedEls[curToNodeId])) {
                        if (compareNodeNames(savedEl, curToNodeChild)) {
                            morphEl(savedEl, curToNodeChild, true);
                            // We want to append the saved element instead
                            curToNodeChild = savedEl;
                        } else {
                            delete savedEls[curToNodeId];
                            onNodeDiscarded(savedEl);
                        }
                    } else {
                        // The current DOM element in the target tree has an ID
                        // but we did not find a match in any of the
                        // corresponding siblings. We just put the target
                        // element in the old DOM tree but if we later find an
                        // element in the old DOM tree that has a matching ID
                        // then we will replace the target element with the
                        // corresponding old element and morph the old element
                        unmatchedEls[curToNodeId] = curToNodeChild;
                    }
                }

                // If we got this far then we did not find a candidate match for
                // our "to node" and we exhausted all of the children "from"
                // nodes. Therefore, we will just append the current "to node"
                // to the end
                if (onBeforeNodeAdded(curToNodeChild) !== false) {
                    fromEl.appendChild(curToNodeChild);
                    onNodeAdded(curToNodeChild);
                }

                if (curToNodeChild.nodeType === ELEMENT_NODE &&
                    (curToNodeId || curToNodeChild.firstChild)) {
                    // The element that was just added to the original DOM may
                    // have some nested elements with a key/ID that needs to be
                    // matched up with other elements. We'll add the element to
                    // a list so that we can later process the nested elements
                    // if there are any unmatched keyed elements that were
                    // discarded
                    movedEls.push(curToNodeChild);
                }

                curToNodeChild = toNextSibling;
                curFromNodeChild = fromNextSibling;
            }

            // We have processed all of the "to nodes". If curFromNodeChild is
            // non-null then we still have some from nodes left over that need
            // to be removed
            while (curFromNodeChild) {
                fromNextSibling = curFromNodeChild.nextSibling;
                removeNode(curFromNodeChild, fromEl, alreadyVisited);
                curFromNodeChild = fromNextSibling;
            }
        }

        var specialElHandler = specialElHandlers[fromEl.nodeName];
        if (specialElHandler) {
            specialElHandler(fromEl, toEl);
        }
    } // END: morphEl(...)

    var morphedNode = fromNode;
    var morphedNodeType = morphedNode.nodeType;
    var toNodeType = toNode.nodeType;

    if (!childrenOnly) {
        // Handle the case where we are given two DOM nodes that are not
        // compatible (e.g. <div> --> <span> or <div> --> TEXT)
        if (morphedNodeType === ELEMENT_NODE) {
            if (toNodeType === ELEMENT_NODE) {
                if (!compareNodeNames(fromNode, toNode)) {
                    onNodeDiscarded(fromNode);
                    morphedNode = moveChildren(fromNode, createElementNS(toNode.nodeName, toNode.namespaceURI));
                }
            } else {
                // Going from an element node to a text node
                morphedNode = toNode;
            }
        } else if (morphedNodeType === TEXT_NODE || morphedNodeType === COMMENT_NODE) { // Text or comment node
            if (toNodeType === morphedNodeType) {
                morphedNode.nodeValue = toNode.nodeValue;
                return morphedNode;
            } else {
                // Text node to something else
                morphedNode = toNode;
            }
        }
    }

    if (morphedNode === toNode) {
        // The "to node" was not compatible with the "from node" so we had to
        // toss out the "from node" and use the "to node"
        onNodeDiscarded(fromNode);
    } else {
        morphEl(morphedNode, toNode, false, childrenOnly);

        /**
         * What we will do here is walk the tree for the DOM element that was
         * moved from the target DOM tree to the original DOM tree and we will
         * look for keyed elements that could be matched to keyed elements that
         * were earlier discarded.  If we find a match then we will move the
         * saved element into the final DOM tree.
         */
        var handleMovedEl = function(el) {
            var curChild = el.firstChild;
            while (curChild) {
                var nextSibling = curChild.nextSibling;

                var key = getNodeKey(curChild);
                if (key) {
                    var savedEl = savedEls[key];
                    if (savedEl && compareNodeNames(curChild, savedEl)) {
                        curChild.parentNode.replaceChild(savedEl, curChild);
                        // true: already visited the saved el tree
                        morphEl(savedEl, curChild, true);
                        curChild = nextSibling;
                        if (empty(savedEls)) {
                            return false;
                        }
                        continue;
                    }
                }

                if (curChild.nodeType === ELEMENT_NODE) {
                    handleMovedEl(curChild);
                }

                curChild = nextSibling;
            }
        };

        // The loop below is used to possibly match up any discarded
        // elements in the original DOM tree with elemenets from the
        // target tree that were moved over without visiting their
        // children
        if (!empty(savedEls)) {
            handleMovedElsLoop:
            while (movedEls.length) {
                var movedElsTemp = movedEls;
                movedEls = [];
                for (var i=0; i<movedElsTemp.length; i++) {
                    if (handleMovedEl(movedElsTemp[i]) === false) {
                        // There are no more unmatched elements so completely end
                        // the loop
                        break handleMovedElsLoop;
                    }
                }
            }
        }

        // Fire the "onNodeDiscarded" event for any saved elements
        // that never found a new home in the morphed DOM
        for (var savedElId in savedEls) {
            if (savedEls.hasOwnProperty(savedElId)) {
                var savedEl = savedEls[savedElId];
                onNodeDiscarded(savedEl);
                walkDiscardedChildNodes(savedEl);
            }
        }
    }

    if (!childrenOnly && morphedNode !== fromNode && fromNode.parentNode) {
        // If we had to swap out the from node with a new node because the old
        // node was not compatible with the target node then we need to
        // replace the old DOM node in the original DOM tree. This is only
        // possible if the original DOM node was part of a DOM tree which
        // we know is the case if it has a parent node.
        fromNode.parentNode.replaceChild(morphedNode, fromNode);
    }

    return morphedNode;
}

module.exports = morphdom;

});
$_mod.installed("marko-widgets$6.4.1", "warp10", "1.3.0");
$_mod.def("/warp10$1.3.0/src/finalize", function(require, exports, module, __filename, __dirname) { var isArray = Array.isArray;

function resolve(object, path, len) {
    var current = object;
    for (var i=0; i<len; i++) {
        current = current[path[i]];
    }

    return current;
}

function resolveType(info) {
    if (info.type === 'Date') {
        return new Date(info.value);
    } else {
        throw new Error('Bad type');
    }
}

module.exports = function finalize(outer) {
    if (!outer) {
        return outer;
    }

    var assignments = outer.$$;
    if (assignments) {
        var object = outer.o;

        if (assignments) {
            for (var i=0, len=assignments.length; i<len; i++) {
                var assignment = assignments[i];

                var rhs = assignment.r;
                var rhsValue;

                if (isArray(rhs)) {
                    rhsValue = resolve(object, rhs, rhs.length);
                } else {
                    rhsValue = resolveType(rhs);
                }

                var lhs = assignment.l;
                var lhsLast = lhs.length-1;

                if (lhsLast === -1) {
                    return rhsValue;
                } else {
                    var lhsParent = resolve(object, lhs, lhsLast);
                    lhsParent[lhs[lhsLast]] = rhsValue;
                }
            }
        }

        return object == null ? null : object;
    } else {
        return outer;
    }

};
});
$_mod.def("/warp10$1.3.0/finalize", function(require, exports, module, __filename, __dirname) { module.exports = require('/warp10$1.3.0/src/finalize'/*'./src/finalize'*/);
});
$_mod.run("/marko-widgets$6.4.1/lib/client-init");
$_mod.def("/marko-widgets$6.4.1/lib/widget-args-id", function(require, exports, module, __filename, __dirname) { /*
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

var repeatedId = require('/marko-widgets$6.4.1/lib/repeated-id'/*'../lib/repeated-id'*/);

module.exports = function widgetArgsId(widgetArgs) {
    var widgetId = widgetArgs.id;

    if (widgetId) {
        var out = widgetArgs.out;
        var scope = widgetArgs.scope;

        if (widgetId.charAt(0) === '#') {
            return widgetId.substring(1);
        } else {
            var resolvedId;

            if (widgetId.endsWith('[]')) {
                resolvedId = repeatedId.nextId(out, scope, widgetId);
            } else {
                resolvedId = scope + '-' + widgetId;
            }

            return resolvedId;
        }
    }
};
});
$_mod.def("/marko-widgets$6.4.1/taglib/helpers/widgetBody", function(require, exports, module, __filename, __dirname) { /*
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

var markoWidgets = require('/marko-widgets$6.4.1/lib/index-browser'/*'../../'*/);
var escapeXml = require('/raptor-util$2.0.0/escapeXml'/*'raptor-util/escapeXml'*/);
var isBrowser = typeof window !== 'undefined';

module.exports = function widgetBody(out, id, content, widget) {
    if (id != null && content == null) {
        if (isBrowser) {
            // There is no body content so let's see if we should reuse
            // the existing body content in the DOM
            var existingEl = document.getElementById(id);
            if (existingEl) {
                var widgetsContext = markoWidgets.getWidgetsContext(out);
                widgetsContext.addPreservedDOMNode(existingEl, true /* body only */);
            }
        }
    } else if (typeof content === 'function') {
        content(out, widget);
    } else {
        if (typeof content === 'string') {
            content = escapeXml(content);
        }
        out.write(content);
    }
};
});
$_mod.def("/marko-widgets$6.4.1/taglib/widget-tag", function(require, exports, module, __filename, __dirname) { /*
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

'use strict';
var markoWidgets = require('/marko-widgets$6.4.1/lib/index-browser'/*'../'*/);
var extend = require('/raptor-util$2.0.0/extend'/*'raptor-util/extend'*/);
var widgetArgsId = require('/marko-widgets$6.4.1/lib/widget-args-id'/*'../lib/widget-args-id'*/);
var widgetBodyHelper = require('/marko-widgets$6.4.1/taglib/helpers/widgetBody'/*'./helpers/widgetBody'*/);

var DUMMY_WIDGET_DEF = {
        elId: function () {
        }
    };

/**
 * Look in in the DOM to see if a widget with the same ID and type already exists.
 */
function getExistingWidget(id, type) {
    var existingEl = document.getElementById(id);
    var existingWidget;

    if (existingEl && (existingWidget = existingEl.__widget) && existingWidget.__type === type) {
        return existingWidget;
    }

    return null;
}

function registerWidgetType(widgetType) {
    if (!widgetType.registered) {
        // Only need to register the widget type once
        widgetType.registered = true;
        markoWidgets.registerWidget(widgetType);
    }
}

function preserveWidgetEl(existingWidget, out, widgetsContext, widgetBody) {
    // We put a placeholder element in the output stream to ensure that the existing
    // DOM node is matched up correctly when using morphdom.
    var tagName = existingWidget.el.tagName;
    out.write('<' + tagName + ' id="' + existingWidget.id + '">');
    var hasUnpreservedBody = false;

    if (widgetBody && existingWidget.bodyEl) {
        hasUnpreservedBody = true;
        widgetBodyHelper(out, existingWidget.bodyEl.id, widgetBody, existingWidget);
    }

    out.write('</' + tagName + '>');
    existingWidget._reset(); // The widget is no longer dirty so reset internal flags
    widgetsContext.addPreservedDOMNode(existingWidget.el, null, hasUnpreservedBody); // Mark the element as being preserved (for morphdom)
}


module.exports = function render(input, out) {
    var global = out.global;

    if (!global.__widgetsBeginAsyncAdded) {
        global.__widgetsBeginAsyncAdded = true;
        out.on('beginAsync', function(event) {
            var parentAsyncWriter = event.parentWriter;
            var asyncWriter = event.writer;
            var widgetsContext = global.widgets;
            var widgetStack;

            if (widgetsContext && (widgetStack = widgetsContext.widgetStack).length) {
                // All of the widgets in this async block should be
                // initialized after the widgets in the parent. Therefore,
                // we will create a new WidgetsContext for the nested
                // async block and will create a new widget stack where the current
                // widget in the parent block is the only widget in the nested
                // stack (to begin with). This will result in top-level widgets
                // of the async block being added as children of the widget in the
                // parent block.
                var nestedWidgetsContext = new markoWidgets.WidgetsContext(out);
                nestedWidgetsContext.widgetStack = [widgetStack[widgetStack.length-1]];
                asyncWriter.data.widgets = nestedWidgetsContext;
            }

            asyncWriter.data.widgetArgs = parentAsyncWriter.data.widgetArgs;
        });
    }

    var type = input.type;
    var config = input.config || input._cfg;
    var state = input.state || input._state;
    var props = input.props || input._props;
    var widgetArgs = out.data.widgetArgs;
    var bodyElId = input.body;
    var widgetBody = input._body;
    var typeName = type && type.name;

    var id = input.id;
    var extendList;
    var hasDomEvents = input.hasDomEvents;
    var customEvents;
    var scope;
    var extendState;
    var extendConfig;

    if (widgetArgs) {
        delete out.data.widgetArgs;
        scope = widgetArgs.scope;

        id = id || widgetArgsId(widgetArgs);
        extendList = widgetArgs.extend;
        customEvents = widgetArgs.customEvents;

        if (extendList) {
            extendList = extendList.map(function(extendType) {
                registerWidgetType(extendType);
                return extendType.name;
            });
        }

        if ((extendState = widgetArgs.extendState)) {
            if (state) {
                extend(state, extendState);
            } else {
                state = extendState;
            }
        }

        if ((extendConfig = widgetArgs.extendConfig)) {
            if (config) {
                extend(config, extendConfig);
            } else {
                config = extendConfig;
            }
        }
    }

    var rerenderWidget = global.__rerenderWidget;
    var isRerender = global.__rerender === true;

    var widgetsContext = markoWidgets.getWidgetsContext(out);

    if (!id) {
        var parentWidget = widgetsContext.getCurrentWidget();

        if (parentWidget) {
            id = parentWidget.nextId();
        }
    }

    var existingWidget;

    if (rerenderWidget) {
        existingWidget = rerenderWidget;
        id = rerenderWidget.id;
        delete global.__rerenderWidget;
    } else if (isRerender) {
        existingWidget = getExistingWidget(id, typeName);
    }

    if (!id && input.hasOwnProperty('id')) {
        throw new Error('Invalid widget ID for "' + typeName + '"');
    }

    if (typeName) {
        registerWidgetType(type);

        var shouldRenderBody = true;

        if (existingWidget && !rerenderWidget) {
            // This is a nested widget found during a rerender. We don't want to needlessly
            // rerender the widget if that is not necessary. If the widget is a stateful
            // widget then we update the existing widget with the new state.
            if (state) {
                existingWidget._replaceState(state); // Update the existing widget state using the internal/private
                                                     // method to ensure that another update is not queued up

                // If the widget has custom state update handlers then we will use those methods
                // to update the widget.
                if (existingWidget._processUpdateHandlers() === true) {
                    // If _processUpdateHandlers() returns true then that means
                    // that the widget is now up-to-date and we can skip rerendering it.
                    shouldRenderBody = false;
                    preserveWidgetEl(existingWidget, out, widgetsContext, widgetBody);
                    return;
                }
            }

            // If the widget is not dirty (no state changes) and shouldUpdate() returns false
            // then skip rerendering the widget.
            if (!existingWidget.isDirty() && !existingWidget.shouldUpdate(props, state)) {
                shouldRenderBody = false;
                preserveWidgetEl(existingWidget, out, widgetsContext, widgetBody);
                return;
            }
        }

        if (existingWidget) {
            existingWidget._emitLifecycleEvent('beforeUpdate');
        }

        var widgetDef = widgetsContext.beginWidget({
            type: typeName,
            id: id,
            config: config,
            state: state,
            hasDomEvents: hasDomEvents,
            customEvents: customEvents,
            scope: scope,
            createWidget: input.createWidget,
            extend: extendList,
            existingWidget: existingWidget,
            bodyElId: bodyElId
        });

        // Only render the widget if it needs to be rerendered
        if (shouldRenderBody) {
            input.renderBody(out, widgetDef);
            markoWidgets.writeDomEventsEl(widgetDef, out);
        }

        widgetDef.end();
    } else {
        input.renderBody(out, DUMMY_WIDGET_DEF);
    }
};
});
$_mod.installed("dirpublish-monitor$1.0.0", "marko", "3.12.1");
$_mod.def("/dirpublish-monitor$1.0.0/src/components/monitor/template.marko", function(require, exports, module, __filename, __dirname) { function create(__helpers) {
  var __widgetType = {
          name: "/dirpublish-monitor$1.0.0/src/components/monitor/widget",
          def: function() {
            return require('/dirpublish-monitor$1.0.0/src/components/monitor/widget'/*"./widget"*/);
          }
        },
      __markoWidgets = require('/marko-widgets$6.4.1/lib/index-browser'/*"marko-widgets"*/),
      __widgetAttrs = __markoWidgets.attrs,
      str = __helpers.s,
      empty = __helpers.e,
      notEmpty = __helpers.ne,
      escapeXml = __helpers.x,
      __loadTag = __helpers.t,
      w_widget_tag = __loadTag(require('/marko-widgets$6.4.1/taglib/widget-tag'/*"marko-widgets/taglib/widget-tag"*/)),
      attr = __helpers.a,
      attrs = __helpers.as;

  return function render(data, out) {
    w_widget_tag({
        type: __widgetType,
        _cfg: data.widgetConfig,
        _state: data.widgetState,
        _props: data.widgetProps,
        _body: data.widgetBody,
        renderBody: function renderBody(out, widget) {
          out.w("<div" +
            attr("id", widget.id) +
            attrs(__widgetAttrs(widget)) +
            "><p>Test</p></div>");
        }
      }, out);
  };
}

(module.exports = require('/marko$3.12.1/runtime/marko-runtime'/*"marko"*/).c(__filename)).c(create);

});
$_mod.def("/dirpublish-monitor$1.0.0/src/components/monitor/widget", function(require, exports, module, __filename, __dirname) { 'use strict';

const defineComponent = require('/marko-widgets$6.4.1/lib/index-browser'/*'marko-widgets'*/).defineComponent;

module.exports = defineComponent({
    template: require('/dirpublish-monitor$1.0.0/src/components/monitor/template.marko'/*'./template.marko'*/),
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

});
(function UMDish(name, context, definition, plugins) {
  context[name] = definition.call(context);
  for (var i = 0; i < plugins.length; i++) {
    plugins[i](context[name])
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = context[name];
  } else if (typeof define === "function" && define.amd) {
    define(function reference() { return context[name]; });
  }
})("Primus", this || {}, function wrapper() {
  var define, module, exports
    , Primus = (function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(_dereq_,module,exports){
'use strict';

/**
 * Create a function that will cleanup the instance.
 *
 * @param {Array|String} keys Properties on the instance that needs to be cleared.
 * @param {Object} options Additional configuration.
 * @returns {Function} Destroy function
 * @api public
 */
module.exports = function demolish(keys, options) {
  var split = /[, ]+/;

  options = options ||  {};
  keys = keys || [];

  if ('string' === typeof keys) keys = keys.split(split);

  /**
   * Run addition cleanup hooks.
   *
   * @param {String} key Name of the clean up hook to run.
   * @param {Mixed} selfie Reference to the instance we're cleaning up.
   * @api private
   */
  function run(key, selfie) {
    if (!options[key]) return;
    if ('string' === typeof options[key]) options[key] = options[key].split(split);
    if ('function' === typeof options[key]) return options[key].call(selfie);

    for (var i = 0, type, what; i < options[key].length; i++) {
      what = options[key][i];
      type = typeof what;

      if ('function' === type) {
        what.call(selfie);
      } else if ('string' === type && 'function' === typeof selfie[what]) {
        selfie[what]();
      }
    }
  }

  /**
   * Destroy the instance completely and clean up all the existing references.
   *
   * @returns {Boolean}
   * @api public
   */
  return function destroy() {
    var selfie = this
      , i = 0
      , prop;

    if (selfie[keys[0]] === null) return false;
    run('before', selfie);

    for (; i < keys.length; i++) {
      prop = keys[i];

      if (selfie[prop]) {
        if ('function' === typeof selfie[prop].destroy) selfie[prop].destroy();
        selfie[prop] = null;
      }
    }

    if (selfie.emit) selfie.emit('destroy');
    run('after', selfie);

    return true;
  };
};

},{}],2:[function(_dereq_,module,exports){
'use strict';

/**
 * Returns a function that when invoked executes all the listeners of the
 * given event with the given arguments.
 *
 * @returns {Function} The function that emits all the things.
 * @api public
 */
module.exports = function emits() {
  var self = this
    , parser;

  for (var i = 0, l = arguments.length, args = new Array(l); i < l; i++) {
    args[i] = arguments[i];
  }

  //
  // If the last argument is a function, assume that it's a parser.
  //
  if ('function' !== typeof args[args.length - 1]) return function emitter() {
    for (var i = 0, l = arguments.length, arg = new Array(l); i < l; i++) {
      arg[i] = arguments[i];
    }

    return self.emit.apply(self, args.concat(arg));
  };

  parser = args.pop();

  /**
   * The actual function that emits the given event. It returns a boolean
   * indicating if the event was emitted.
   *
   * @returns {Boolean}
   * @api public
   */
  return function emitter() {
    for (var i = 0, l = arguments.length, arg = new Array(l + 1); i < l; i++) {
      arg[i + 1] = arguments[i];
    }

    /**
     * Async completion method for the parser.
     *
     * @param {Error} err Optional error when parsing failed.
     * @param {Mixed} returned Emit instructions.
     * @api private
     */
    arg[0] = function next(err, returned) {
      if (err) return self.emit('error', err);

      arg = returned === undefined
        ? arg.slice(1) : returned === null
          ? [] : returned;

      self.emit.apply(self, args.concat(arg));
    };

    parser.apply(self, arg);
    return true;
  };
};

},{}],3:[function(_dereq_,module,exports){
'use strict';

var has = Object.prototype.hasOwnProperty
  , prefix = '~';

/**
 * Constructor to create a storage for our `EE` objects.
 * An `Events` instance is a plain object whose properties are event names.
 *
 * @constructor
 * @api private
 */
function Events() {}

//
// We try to not inherit from `Object.prototype`. In some engines creating an
// instance in this way is faster than calling `Object.create(null)` directly.
// If `Object.create(null)` is not supported we prefix the event names with a
// character to make sure that the built-in object properties are not
// overridden or used as an attack vector.
//
if (Object.create) {
  Events.prototype = Object.create(null);

  //
  // This hack is needed because the `__proto__` property is still inherited in
  // some old browsers like Android 4, iPhone 5.1, Opera 11 and Safari 5.
  //
  if (!new Events().__proto__) prefix = false;
}

/**
 * Representation of a single event listener.
 *
 * @param {Function} fn The listener function.
 * @param {Mixed} context The context to invoke the listener with.
 * @param {Boolean} [once=false] Specify if the listener is a one-time listener.
 * @constructor
 * @api private
 */
function EE(fn, context, once) {
  this.fn = fn;
  this.context = context;
  this.once = once || false;
}

/**
 * Minimal `EventEmitter` interface that is molded against the Node.js
 * `EventEmitter` interface.
 *
 * @constructor
 * @api public
 */
function EventEmitter() {
  this._events = new Events();
  this._eventsCount = 0;
}

/**
 * Return an array listing the events for which the emitter has registered
 * listeners.
 *
 * @returns {Array}
 * @api public
 */
EventEmitter.prototype.eventNames = function eventNames() {
  var names = []
    , events
    , name;

  if (this._eventsCount === 0) return names;

  for (name in (events = this._events)) {
    if (has.call(events, name)) names.push(prefix ? name.slice(1) : name);
  }

  if (Object.getOwnPropertySymbols) {
    return names.concat(Object.getOwnPropertySymbols(events));
  }

  return names;
};

/**
 * Return the listeners registered for a given event.
 *
 * @param {String|Symbol} event The event name.
 * @param {Boolean} exists Only check if there are listeners.
 * @returns {Array|Boolean}
 * @api public
 */
EventEmitter.prototype.listeners = function listeners(event, exists) {
  var evt = prefix ? prefix + event : event
    , available = this._events[evt];

  if (exists) return !!available;
  if (!available) return [];
  if (available.fn) return [available.fn];

  for (var i = 0, l = available.length, ee = new Array(l); i < l; i++) {
    ee[i] = available[i].fn;
  }

  return ee;
};

/**
 * Calls each of the listeners registered for a given event.
 *
 * @param {String|Symbol} event The event name.
 * @returns {Boolean} `true` if the event had listeners, else `false`.
 * @api public
 */
EventEmitter.prototype.emit = function emit(event, a1, a2, a3, a4, a5) {
  var evt = prefix ? prefix + event : event;

  if (!this._events[evt]) return false;

  var listeners = this._events[evt]
    , len = arguments.length
    , args
    , i;

  if (listeners.fn) {
    if (listeners.once) this.removeListener(event, listeners.fn, undefined, true);

    switch (len) {
      case 1: return listeners.fn.call(listeners.context), true;
      case 2: return listeners.fn.call(listeners.context, a1), true;
      case 3: return listeners.fn.call(listeners.context, a1, a2), true;
      case 4: return listeners.fn.call(listeners.context, a1, a2, a3), true;
      case 5: return listeners.fn.call(listeners.context, a1, a2, a3, a4), true;
      case 6: return listeners.fn.call(listeners.context, a1, a2, a3, a4, a5), true;
    }

    for (i = 1, args = new Array(len -1); i < len; i++) {
      args[i - 1] = arguments[i];
    }

    listeners.fn.apply(listeners.context, args);
  } else {
    var length = listeners.length
      , j;

    for (i = 0; i < length; i++) {
      if (listeners[i].once) this.removeListener(event, listeners[i].fn, undefined, true);

      switch (len) {
        case 1: listeners[i].fn.call(listeners[i].context); break;
        case 2: listeners[i].fn.call(listeners[i].context, a1); break;
        case 3: listeners[i].fn.call(listeners[i].context, a1, a2); break;
        case 4: listeners[i].fn.call(listeners[i].context, a1, a2, a3); break;
        default:
          if (!args) for (j = 1, args = new Array(len -1); j < len; j++) {
            args[j - 1] = arguments[j];
          }

          listeners[i].fn.apply(listeners[i].context, args);
      }
    }
  }

  return true;
};

/**
 * Add a listener for a given event.
 *
 * @param {String|Symbol} event The event name.
 * @param {Function} fn The listener function.
 * @param {Mixed} [context=this] The context to invoke the listener with.
 * @returns {EventEmitter} `this`.
 * @api public
 */
EventEmitter.prototype.on = function on(event, fn, context) {
  var listener = new EE(fn, context || this)
    , evt = prefix ? prefix + event : event;

  if (!this._events[evt]) this._events[evt] = listener, this._eventsCount++;
  else if (!this._events[evt].fn) this._events[evt].push(listener);
  else this._events[evt] = [this._events[evt], listener];

  return this;
};

/**
 * Add a one-time listener for a given event.
 *
 * @param {String|Symbol} event The event name.
 * @param {Function} fn The listener function.
 * @param {Mixed} [context=this] The context to invoke the listener with.
 * @returns {EventEmitter} `this`.
 * @api public
 */
EventEmitter.prototype.once = function once(event, fn, context) {
  var listener = new EE(fn, context || this, true)
    , evt = prefix ? prefix + event : event;

  if (!this._events[evt]) this._events[evt] = listener, this._eventsCount++;
  else if (!this._events[evt].fn) this._events[evt].push(listener);
  else this._events[evt] = [this._events[evt], listener];

  return this;
};

/**
 * Remove the listeners of a given event.
 *
 * @param {String|Symbol} event The event name.
 * @param {Function} fn Only remove the listeners that match this function.
 * @param {Mixed} context Only remove the listeners that have this context.
 * @param {Boolean} once Only remove one-time listeners.
 * @returns {EventEmitter} `this`.
 * @api public
 */
EventEmitter.prototype.removeListener = function removeListener(event, fn, context, once) {
  var evt = prefix ? prefix + event : event;

  if (!this._events[evt]) return this;
  if (!fn) {
    if (--this._eventsCount === 0) this._events = new Events();
    else delete this._events[evt];
    return this;
  }

  var listeners = this._events[evt];

  if (listeners.fn) {
    if (
         listeners.fn === fn
      && (!once || listeners.once)
      && (!context || listeners.context === context)
    ) {
      if (--this._eventsCount === 0) this._events = new Events();
      else delete this._events[evt];
    }
  } else {
    for (var i = 0, events = [], length = listeners.length; i < length; i++) {
      if (
           listeners[i].fn !== fn
        || (once && !listeners[i].once)
        || (context && listeners[i].context !== context)
      ) {
        events.push(listeners[i]);
      }
    }

    //
    // Reset the array, or remove it completely if we have no more listeners.
    //
    if (events.length) this._events[evt] = events.length === 1 ? events[0] : events;
    else if (--this._eventsCount === 0) this._events = new Events();
    else delete this._events[evt];
  }

  return this;
};

/**
 * Remove all listeners, or those of the specified event.
 *
 * @param {String|Symbol} [event] The event name.
 * @returns {EventEmitter} `this`.
 * @api public
 */
EventEmitter.prototype.removeAllListeners = function removeAllListeners(event) {
  var evt;

  if (event) {
    evt = prefix ? prefix + event : event;
    if (this._events[evt]) {
      if (--this._eventsCount === 0) this._events = new Events();
      else delete this._events[evt];
    }
  } else {
    this._events = new Events();
    this._eventsCount = 0;
  }

  return this;
};

//
// Alias methods names because people roll like that.
//
EventEmitter.prototype.off = EventEmitter.prototype.removeListener;
EventEmitter.prototype.addListener = EventEmitter.prototype.on;

//
// This function doesn't apply anymore.
//
EventEmitter.prototype.setMaxListeners = function setMaxListeners() {
  return this;
};

//
// Expose the prefix.
//
EventEmitter.prefixed = prefix;

//
// Allow `EventEmitter` to be imported as module namespace.
//
EventEmitter.EventEmitter = EventEmitter;

//
// Expose the module.
//
if ('undefined' !== typeof module) {
  module.exports = EventEmitter;
}

},{}],4:[function(_dereq_,module,exports){
if (typeof Object.create === 'function') {
  // implementation from standard node.js 'util' module
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor
    ctor.prototype = Object.create(superCtor.prototype, {
      constructor: {
        value: ctor,
        enumerable: false,
        writable: true,
        configurable: true
      }
    });
  };
} else {
  // old school shim for old browsers
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor
    var TempCtor = function () {}
    TempCtor.prototype = superCtor.prototype
    ctor.prototype = new TempCtor()
    ctor.prototype.constructor = ctor
  }
}

},{}],5:[function(_dereq_,module,exports){
'use strict';

var regex = new RegExp('^((?:\\d+)?\\.?\\d+) *('+ [
  'milliseconds?',
  'msecs?',
  'ms',
  'seconds?',
  'secs?',
  's',
  'minutes?',
  'mins?',
  'm',
  'hours?',
  'hrs?',
  'h',
  'days?',
  'd',
  'weeks?',
  'wks?',
  'w',
  'years?',
  'yrs?',
  'y'
].join('|') +')?$', 'i');

var second = 1000
  , minute = second * 60
  , hour = minute * 60
  , day = hour * 24
  , week = day * 7
  , year = day * 365;

/**
 * Parse a time string and return the number value of it.
 *
 * @param {String} ms Time string.
 * @returns {Number}
 * @api private
 */
module.exports = function millisecond(ms) {
  var type = typeof ms
    , amount
    , match;

  if ('number' === type) return ms;
  else if ('string' !== type || '0' === ms || !ms) return 0;
  else if (+ms) return +ms;

  //
  // We are vulnerable to the regular expression denial of service (ReDoS).
  // In order to mitigate this we don't parse the input string if it is too long.
  // See https://nodesecurity.io/advisories/46.
  //
  if (ms.length > 10000 || !(match = regex.exec(ms))) return 0;

  amount = parseFloat(match[1]);

  switch (match[2].toLowerCase()) {
    case 'years':
    case 'year':
    case 'yrs':
    case 'yr':
    case 'y':
      return amount * year;

    case 'weeks':
    case 'week':
    case 'wks':
    case 'wk':
    case 'w':
      return amount * week;

    case 'days':
    case 'day':
    case 'd':
      return amount * day;

    case 'hours':
    case 'hour':
    case 'hrs':
    case 'hr':
    case 'h':
      return amount * hour;

    case 'minutes':
    case 'minute':
    case 'mins':
    case 'min':
    case 'm':
      return amount * minute;

    case 'seconds':
    case 'second':
    case 'secs':
    case 'sec':
    case 's':
      return amount * second;

    default:
      return amount;
  }
};

},{}],6:[function(_dereq_,module,exports){
'use strict';

/**
 * Wrap callbacks to prevent double execution.
 *
 * @param {Function} fn Function that should only be called once.
 * @returns {Function} A wrapped callback which prevents execution.
 * @api public
 */
module.exports = function one(fn) {
  var called = 0
    , value;

  /**
   * The function that prevents double execution.
   *
   * @api private
   */
  function onetime() {
    if (called) return value;

    called = 1;
    value = fn.apply(this, arguments);
    fn = null;

    return value;
  }

  //
  // To make debugging more easy we want to use the name of the supplied
  // function. So when you look at the functions that are assigned to event
  // listeners you don't see a load of `onetime` functions but actually the
  // names of the functions that this module will call.
  //
  onetime.displayName = fn.displayName || fn.name || onetime.displayName || onetime.name;
  return onetime;
};

},{}],7:[function(_dereq_,module,exports){
'use strict';

var has = Object.prototype.hasOwnProperty;

/**
 * Simple query string parser.
 *
 * @param {String} query The query string that needs to be parsed.
 * @returns {Object}
 * @api public
 */
function querystring(query) {
  var parser = /([^=?&]+)=?([^&]*)/g
    , result = {}
    , part;

  //
  // Little nifty parsing hack, leverage the fact that RegExp.exec increments
  // the lastIndex property so we can continue executing this loop until we've
  // parsed all results.
  //
  for (;
    part = parser.exec(query);
    result[decodeURIComponent(part[1])] = decodeURIComponent(part[2])
  );

  return result;
}

/**
 * Transform a query string to an object.
 *
 * @param {Object} obj Object that should be transformed.
 * @param {String} prefix Optional prefix.
 * @returns {String}
 * @api public
 */
function querystringify(obj, prefix) {
  prefix = prefix || '';

  var pairs = [];

  //
  // Optionally prefix with a '?' if needed
  //
  if ('string' !== typeof prefix) prefix = '?';

  for (var key in obj) {
    if (has.call(obj, key)) {
      pairs.push(encodeURIComponent(key) +'='+ encodeURIComponent(obj[key]));
    }
  }

  return pairs.length ? prefix + pairs.join('&') : '';
}

//
// Expose the module.
//
exports.stringify = querystringify;
exports.parse = querystring;

},{}],8:[function(_dereq_,module,exports){
'use strict';

var EventEmitter = _dereq_('eventemitter3')
  , millisecond = _dereq_('millisecond')
  , destroy = _dereq_('demolish')
  , Tick = _dereq_('tick-tock')
  , one = _dereq_('one-time');

/**
 * Returns sane defaults about a given value.
 *
 * @param {String} name Name of property we want.
 * @param {Recovery} selfie Recovery instance that got created.
 * @param {Object} opts User supplied options we want to check.
 * @returns {Number} Some default value.
 * @api private
 */
function defaults(name, selfie, opts) {
  return millisecond(
    name in opts ? opts[name] : (name in selfie ? selfie[name] : Recovery[name])
  );
}

/**
 * Attempt to recover your connection with reconnection attempt.
 *
 * @constructor
 * @param {Object} options Configuration
 * @api public
 */
function Recovery(options) {
  var recovery = this;

  if (!(recovery instanceof Recovery)) return new Recovery(options);

  options = options || {};

  recovery.attempt = null;        // Stores the current reconnect attempt.
  recovery._fn = null;            // Stores the callback.

  recovery['reconnect timeout'] = defaults('reconnect timeout', recovery, options);
  recovery.retries = defaults('retries', recovery, options);
  recovery.factor = defaults('factor', recovery, options);
  recovery.max = defaults('max', recovery, options);
  recovery.min = defaults('min', recovery, options);
  recovery.timers = new Tick(recovery);
}

Recovery.prototype = new EventEmitter();
Recovery.prototype.constructor = Recovery;

Recovery['reconnect timeout'] = '30 seconds';  // Maximum time to wait for an answer.
Recovery.max = Infinity;                       // Maximum delay.
Recovery.min = '500 ms';                       // Minimum delay.
Recovery.retries = 10;                         // Maximum amount of retries.
Recovery.factor = 2;                           // Exponential back off factor.

/**
 * Start a new reconnect procedure.
 *
 * @returns {Recovery}
 * @api public
 */
Recovery.prototype.reconnect = function reconnect() {
  var recovery = this;

  return recovery.backoff(function backedoff(err, opts) {
    opts.duration = (+new Date()) - opts.start;

    if (err) return recovery.emit('reconnect failed', err, opts);

    recovery.emit('reconnected', opts);
  }, recovery.attempt);
};

/**
 * Exponential back off algorithm for retry operations. It uses a randomized
 * retry so we don't DDOS our server when it goes down under pressure.
 *
 * @param {Function} fn Callback to be called after the timeout.
 * @param {Object} opts Options for configuring the timeout.
 * @returns {Recovery}
 * @api private
 */
Recovery.prototype.backoff = function backoff(fn, opts) {
  var recovery = this;

  opts = opts || recovery.attempt || {};

  //
  // Bailout when we already have a back off process running. We shouldn't call
  // the callback then.
  //
  if (opts.backoff) return recovery;

  opts['reconnect timeout'] = defaults('reconnect timeout', recovery, opts);
  opts.retries = defaults('retries', recovery, opts);
  opts.factor = defaults('factor', recovery, opts);
  opts.max = defaults('max', recovery, opts);
  opts.min = defaults('min', recovery, opts);

  opts.start = +opts.start || +new Date();
  opts.duration = +opts.duration || 0;
  opts.attempt = +opts.attempt || 0;

  //
  // Bailout if we are about to make too much attempts.
  //
  if (opts.attempt === opts.retries) {
    fn.call(recovery, new Error('Unable to recover'), opts);
    return recovery;
  }

  //
  // Prevent duplicate back off attempts using the same options object and
  // increment our attempt as we're about to have another go at this thing.
  //
  opts.backoff = true;
  opts.attempt++;

  recovery.attempt = opts;

  //
  // Calculate the timeout, but make it randomly so we don't retry connections
  // at the same interval and defeat the purpose. This exponential back off is
  // based on the work of:
  //
  // http://dthain.blogspot.nl/2009/02/exponential-backoff-in-distributed.html
  //
  opts.scheduled = opts.attempt !== 1
    ? Math.min(Math.round(
        (Math.random() + 1) * opts.min * Math.pow(opts.factor, opts.attempt - 1)
      ), opts.max)
    : opts.min;

  recovery.timers.setTimeout('reconnect', function delay() {
    opts.duration = (+new Date()) - opts.start;
    opts.backoff = false;
    recovery.timers.clear('reconnect, timeout');

    //
    // Create a `one` function which can only be called once. So we can use the
    // same function for different types of invocations to create a much better
    // and usable API.
    //
    var connect = recovery._fn = one(function connect(err) {
      recovery.reset();

      if (err) return recovery.backoff(fn, opts);

      fn.call(recovery, undefined, opts);
    });

    recovery.emit('reconnect', opts, connect);
    recovery.timers.setTimeout('timeout', function timeout() {
      var err = new Error('Failed to reconnect in a timely manner');
      opts.duration = (+new Date()) - opts.start;

      recovery.emit('reconnect timeout', err, opts);
      connect(err);
    }, opts['reconnect timeout']);
  }, opts.scheduled);

  //
  // Emit a `reconnecting` event with current reconnect options. This allows
  // them to update the UI and provide their users with feedback.
  //
  recovery.emit('reconnect scheduled', opts);

  return recovery;
};

/**
 * Check if the reconnection process is currently reconnecting.
 *
 * @returns {Boolean}
 * @api public
 */
Recovery.prototype.reconnecting = function reconnecting() {
  return !!this.attempt;
};

/**
 * Tell our reconnection procedure that we're passed.
 *
 * @param {Error} err Reconnection failed.
 * @returns {Recovery}
 * @api public
 */
Recovery.prototype.reconnected = function reconnected(err) {
  if (this._fn) this._fn(err);
  return this;
};

/**
 * Reset the reconnection attempt so it can be re-used again.
 *
 * @returns {Recovery}
 * @api public
 */
Recovery.prototype.reset = function reset() {
  this._fn = this.attempt = null;
  this.timers.clear('reconnect, timeout');

  return this;
};

/**
 * Clean up the instance.
 *
 * @type {Function}
 * @returns {Boolean}
 * @api public
 */
Recovery.prototype.destroy = destroy('timers attempt _fn');

//
// Expose the module.
//
module.exports = Recovery;

},{"demolish":1,"eventemitter3":9,"millisecond":5,"one-time":6,"tick-tock":11}],9:[function(_dereq_,module,exports){
'use strict';

//
// We store our EE objects in a plain object whose properties are event names.
// If `Object.create(null)` is not supported we prefix the event names with a
// `~` to make sure that the built-in object properties are not overridden or
// used as an attack vector.
// We also assume that `Object.create(null)` is available when the event name
// is an ES6 Symbol.
//
var prefix = typeof Object.create !== 'function' ? '~' : false;

/**
 * Representation of a single EventEmitter function.
 *
 * @param {Function} fn Event handler to be called.
 * @param {Mixed} context Context for function execution.
 * @param {Boolean} once Only emit once
 * @api private
 */
function EE(fn, context, once) {
  this.fn = fn;
  this.context = context;
  this.once = once || false;
}

/**
 * Minimal EventEmitter interface that is molded against the Node.js
 * EventEmitter interface.
 *
 * @constructor
 * @api public
 */
function EventEmitter() { /* Nothing to set */ }

/**
 * Holds the assigned EventEmitters by name.
 *
 * @type {Object}
 * @private
 */
EventEmitter.prototype._events = undefined;

/**
 * Return a list of assigned event listeners.
 *
 * @param {String} event The events that should be listed.
 * @param {Boolean} exists We only need to know if there are listeners.
 * @returns {Array|Boolean}
 * @api public
 */
EventEmitter.prototype.listeners = function listeners(event, exists) {
  var evt = prefix ? prefix + event : event
    , available = this._events && this._events[evt];

  if (exists) return !!available;
  if (!available) return [];
  if (available.fn) return [available.fn];

  for (var i = 0, l = available.length, ee = new Array(l); i < l; i++) {
    ee[i] = available[i].fn;
  }

  return ee;
};

/**
 * Emit an event to all registered event listeners.
 *
 * @param {String} event The name of the event.
 * @returns {Boolean} Indication if we've emitted an event.
 * @api public
 */
EventEmitter.prototype.emit = function emit(event, a1, a2, a3, a4, a5) {
  var evt = prefix ? prefix + event : event;

  if (!this._events || !this._events[evt]) return false;

  var listeners = this._events[evt]
    , len = arguments.length
    , args
    , i;

  if ('function' === typeof listeners.fn) {
    if (listeners.once) this.removeListener(event, listeners.fn, undefined, true);

    switch (len) {
      case 1: return listeners.fn.call(listeners.context), true;
      case 2: return listeners.fn.call(listeners.context, a1), true;
      case 3: return listeners.fn.call(listeners.context, a1, a2), true;
      case 4: return listeners.fn.call(listeners.context, a1, a2, a3), true;
      case 5: return listeners.fn.call(listeners.context, a1, a2, a3, a4), true;
      case 6: return listeners.fn.call(listeners.context, a1, a2, a3, a4, a5), true;
    }

    for (i = 1, args = new Array(len -1); i < len; i++) {
      args[i - 1] = arguments[i];
    }

    listeners.fn.apply(listeners.context, args);
  } else {
    var length = listeners.length
      , j;

    for (i = 0; i < length; i++) {
      if (listeners[i].once) this.removeListener(event, listeners[i].fn, undefined, true);

      switch (len) {
        case 1: listeners[i].fn.call(listeners[i].context); break;
        case 2: listeners[i].fn.call(listeners[i].context, a1); break;
        case 3: listeners[i].fn.call(listeners[i].context, a1, a2); break;
        default:
          if (!args) for (j = 1, args = new Array(len -1); j < len; j++) {
            args[j - 1] = arguments[j];
          }

          listeners[i].fn.apply(listeners[i].context, args);
      }
    }
  }

  return true;
};

/**
 * Register a new EventListener for the given event.
 *
 * @param {String} event Name of the event.
 * @param {Functon} fn Callback function.
 * @param {Mixed} context The context of the function.
 * @api public
 */
EventEmitter.prototype.on = function on(event, fn, context) {
  var listener = new EE(fn, context || this)
    , evt = prefix ? prefix + event : event;

  if (!this._events) this._events = prefix ? {} : Object.create(null);
  if (!this._events[evt]) this._events[evt] = listener;
  else {
    if (!this._events[evt].fn) this._events[evt].push(listener);
    else this._events[evt] = [
      this._events[evt], listener
    ];
  }

  return this;
};

/**
 * Add an EventListener that's only called once.
 *
 * @param {String} event Name of the event.
 * @param {Function} fn Callback function.
 * @param {Mixed} context The context of the function.
 * @api public
 */
EventEmitter.prototype.once = function once(event, fn, context) {
  var listener = new EE(fn, context || this, true)
    , evt = prefix ? prefix + event : event;

  if (!this._events) this._events = prefix ? {} : Object.create(null);
  if (!this._events[evt]) this._events[evt] = listener;
  else {
    if (!this._events[evt].fn) this._events[evt].push(listener);
    else this._events[evt] = [
      this._events[evt], listener
    ];
  }

  return this;
};

/**
 * Remove event listeners.
 *
 * @param {String} event The event we want to remove.
 * @param {Function} fn The listener that we need to find.
 * @param {Mixed} context Only remove listeners matching this context.
 * @param {Boolean} once Only remove once listeners.
 * @api public
 */
EventEmitter.prototype.removeListener = function removeListener(event, fn, context, once) {
  var evt = prefix ? prefix + event : event;

  if (!this._events || !this._events[evt]) return this;

  var listeners = this._events[evt]
    , events = [];

  if (fn) {
    if (listeners.fn) {
      if (
           listeners.fn !== fn
        || (once && !listeners.once)
        || (context && listeners.context !== context)
      ) {
        events.push(listeners);
      }
    } else {
      for (var i = 0, length = listeners.length; i < length; i++) {
        if (
             listeners[i].fn !== fn
          || (once && !listeners[i].once)
          || (context && listeners[i].context !== context)
        ) {
          events.push(listeners[i]);
        }
      }
    }
  }

  //
  // Reset the array, or remove it completely if we have no more listeners.
  //
  if (events.length) {
    this._events[evt] = events.length === 1 ? events[0] : events;
  } else {
    delete this._events[evt];
  }

  return this;
};

/**
 * Remove all listeners or only the listeners for the specified event.
 *
 * @param {String} event The event want to remove all listeners for.
 * @api public
 */
EventEmitter.prototype.removeAllListeners = function removeAllListeners(event) {
  if (!this._events) return this;

  if (event) delete this._events[prefix ? prefix + event : event];
  else this._events = prefix ? {} : Object.create(null);

  return this;
};

//
// Alias methods names because people roll like that.
//
EventEmitter.prototype.off = EventEmitter.prototype.removeListener;
EventEmitter.prototype.addListener = EventEmitter.prototype.on;

//
// This function doesn't apply anymore.
//
EventEmitter.prototype.setMaxListeners = function setMaxListeners() {
  return this;
};

//
// Expose the prefix.
//
EventEmitter.prefixed = prefix;

//
// Expose the module.
//
if ('undefined' !== typeof module) {
  module.exports = EventEmitter;
}

},{}],10:[function(_dereq_,module,exports){
'use strict';

/**
 * Check if we're required to add a port number.
 *
 * @see https://url.spec.whatwg.org/#default-port
 * @param {Number|String} port Port number we need to check
 * @param {String} protocol Protocol we need to check against.
 * @returns {Boolean} Is it a default port for the given protocol
 * @api private
 */
module.exports = function required(port, protocol) {
  protocol = protocol.split(':')[0];
  port = +port;

  if (!port) return false;

  switch (protocol) {
    case 'http':
    case 'ws':
    return port !== 80;

    case 'https':
    case 'wss':
    return port !== 443;

    case 'ftp':
    return port !== 21;

    case 'gopher':
    return port !== 70;

    case 'file':
    return false;
  }

  return port !== 0;
};

},{}],11:[function(_dereq_,module,exports){
'use strict';

var has = Object.prototype.hasOwnProperty
  , ms = _dereq_('millisecond');

/**
 * Timer instance.
 *
 * @constructor
 * @param {Object} timer New timer instance.
 * @param {Function} clear Clears the timer instance.
 * @param {Function} duration Duration of the timer.
 * @param {Function} fn The functions that need to be executed.
 * @api private
 */
function Timer(timer, clear, duration, fn) {
  this.start = +(new Date());
  this.duration = duration;
  this.clear = clear;
  this.timer = timer;
  this.fns = [fn];
}

/**
 * Calculate the time left for a given timer.
 *
 * @returns {Number} Time in milliseconds.
 * @api public
 */
Timer.prototype.remaining = function remaining() {
  return this.duration - this.taken();
};

/**
 * Calculate the amount of time it has taken since we've set the timer.
 *
 * @returns {Number}
 * @api public
 */
Timer.prototype.taken = function taken() {
  return +(new Date()) - this.start;
};

/**
 * Custom wrappers for the various of clear{whatever} functions. We cannot
 * invoke them directly as this will cause thrown errors in Google Chrome with
 * an Illegal Invocation Error
 *
 * @see #2
 * @type {Function}
 * @api private
 */
function unsetTimeout(id) { clearTimeout(id); }
function unsetInterval(id) { clearInterval(id); }
function unsetImmediate(id) { clearImmediate(id); }

/**
 * Simple timer management.
 *
 * @constructor
 * @param {Mixed} context Context of the callbacks that we execute.
 * @api public
 */
function Tick(context) {
  if (!(this instanceof Tick)) return new Tick(context);

  this.timers = {};
  this.context = context || this;
}

/**
 * Return a function which will just iterate over all assigned callbacks and
 * optionally clear the timers from memory if needed.
 *
 * @param {String} name Name of the timer we need to execute.
 * @param {Boolean} clear Also clear from memory.
 * @returns {Function}
 * @api private
 */
Tick.prototype.tock = function ticktock(name, clear) {
  var tock = this;

  return function tickedtock() {
    if (!(name in tock.timers)) return;

    var timer = tock.timers[name]
      , fns = timer.fns.slice()
      , l = fns.length
      , i = 0;

    if (clear) tock.clear(name);
    else tock.start = +new Date();

    for (; i < l; i++) {
      fns[i].call(tock.context);
    }
  };
};

/**
 * Add a new timeout.
 *
 * @param {String} name Name of the timer.
 * @param {Function} fn Completion callback.
 * @param {Mixed} time Duration of the timer.
 * @returns {Tick}
 * @api public
 */
Tick.prototype.setTimeout = function timeout(name, fn, time) {
  var tick = this
    , tock;

  if (tick.timers[name]) {
    tick.timers[name].fns.push(fn);
    return tick;
  }

  tock = ms(time);
  tick.timers[name] = new Timer(
    setTimeout(tick.tock(name, true), ms(time)),
    unsetTimeout,
    tock,
    fn
  );

  return tick;
};

/**
 * Add a new interval.
 *
 * @param {String} name Name of the timer.
 * @param {Function} fn Completion callback.
 * @param {Mixed} time Interval of the timer.
 * @returns {Tick}
 * @api public
 */
Tick.prototype.setInterval = function interval(name, fn, time) {
  var tick = this
    , tock;

  if (tick.timers[name]) {
    tick.timers[name].fns.push(fn);
    return tick;
  }

  tock = ms(time);
  tick.timers[name] = new Timer(
    setInterval(tick.tock(name), ms(time)),
    unsetInterval,
    tock,
    fn
  );

  return tick;
};

/**
 * Add a new setImmediate.
 *
 * @param {String} name Name of the timer.
 * @param {Function} fn Completion callback.
 * @returns {Tick}
 * @api public
 */
Tick.prototype.setImmediate = function immediate(name, fn) {
  var tick = this;

  if ('function' !== typeof setImmediate) return tick.setTimeout(name, fn, 0);

  if (tick.timers[name]) {
    tick.timers[name].fns.push(fn);
    return tick;
  }

  tick.timers[name] = new Timer(
    setImmediate(tick.tock(name, true)),
    unsetImmediate,
    0,
    fn
  );

  return tick;
};

/**
 * Check if we have a timer set.
 *
 * @param {String} name
 * @returns {Boolean}
 * @api public
 */
Tick.prototype.active = function active(name) {
  return name in this.timers;
};

/**
 * Properly clean up all timeout references. If no arguments are supplied we
 * will attempt to clear every single timer that is present.
 *
 * @param {Arguments} ..args.. The names of the timeouts we need to clear
 * @returns {Tick}
 * @api public
 */
Tick.prototype.clear = function clear() {
  var args = arguments.length ? arguments : []
    , tick = this
    , timer, i, l;

  if (args.length === 1 && 'string' === typeof args[0]) {
    args = args[0].split(/[, ]+/);
  }

  if (!args.length) {
    for (timer in tick.timers) {
      if (has.call(tick.timers, timer)) args.push(timer);
    }
  }

  for (i = 0, l = args.length; i < l; i++) {
    timer = tick.timers[args[i]];

    if (!timer) continue;
    timer.clear(timer.timer);

    timer.fns = timer.timer = timer.clear = null;
    delete tick.timers[args[i]];
  }

  return tick;
};

/**
 * Adjust a timeout or interval to a new duration.
 *
 * @returns {Tick}
 * @api public
 */
Tick.prototype.adjust = function adjust(name, time) {
  var interval
    , tick = this
    , tock = ms(time)
    , timer = tick.timers[name];

  if (!timer) return tick;

  interval = timer.clear === unsetInterval;
  timer.clear(timer.timer);
  timer.start = +(new Date());
  timer.duration = tock;
  timer.timer = (interval ? setInterval : setTimeout)(tick.tock(name, !interval), tock);

  return tick;
};

/**
 * We will no longer use this module, prepare your self for global cleanups.
 *
 * @returns {Boolean}
 * @api public
 */
Tick.prototype.end = Tick.prototype.destroy = function end() {
  if (!this.context) return false;

  this.clear();
  this.context = this.timers = null;

  return true;
};

//
// Expose the timer factory.
//
Tick.Timer = Timer;
module.exports = Tick;

},{"millisecond":5}],12:[function(_dereq_,module,exports){
'use strict';

var required = _dereq_('requires-port')
  , lolcation = _dereq_('./lolcation')
  , qs = _dereq_('querystringify')
  , protocolre = /^([a-z][a-z0-9.+-]*:)?(\/\/)?([\S\s]*)/i;

/**
 * These are the parse rules for the URL parser, it informs the parser
 * about:
 *
 * 0. The char it Needs to parse, if it's a string it should be done using
 *    indexOf, RegExp using exec and NaN means set as current value.
 * 1. The property we should set when parsing this value.
 * 2. Indication if it's backwards or forward parsing, when set as number it's
 *    the value of extra chars that should be split off.
 * 3. Inherit from location if non existing in the parser.
 * 4. `toLowerCase` the resulting value.
 */
var rules = [
  ['#', 'hash'],                        // Extract from the back.
  ['?', 'query'],                       // Extract from the back.
  ['/', 'pathname'],                    // Extract from the back.
  ['@', 'auth', 1],                     // Extract from the front.
  [NaN, 'host', undefined, 1, 1],       // Set left over value.
  [/:(\d+)$/, 'port', undefined, 1],    // RegExp the back.
  [NaN, 'hostname', undefined, 1, 1]    // Set left over.
];

/**
 * @typedef ProtocolExtract
 * @type Object
 * @property {String} protocol Protocol matched in the URL, in lowercase.
 * @property {Boolean} slashes `true` if protocol is followed by "//", else `false`.
 * @property {String} rest Rest of the URL that is not part of the protocol.
 */

/**
 * Extract protocol information from a URL with/without double slash ("//").
 *
 * @param {String} address URL we want to extract from.
 * @return {ProtocolExtract} Extracted information.
 * @api private
 */
function extractProtocol(address) {
  var match = protocolre.exec(address);

  return {
    protocol: match[1] ? match[1].toLowerCase() : '',
    slashes: !!match[2],
    rest: match[3]
  };
}

/**
 * Resolve a relative URL pathname against a base URL pathname.
 *
 * @param {String} relative Pathname of the relative URL.
 * @param {String} base Pathname of the base URL.
 * @return {String} Resolved pathname.
 * @api private
 */
function resolve(relative, base) {
  var path = (base || '/').split('/').slice(0, -1).concat(relative.split('/'))
    , i = path.length
    , last = path[i - 1]
    , unshift = false
    , up = 0;

  while (i--) {
    if (path[i] === '.') {
      path.splice(i, 1);
    } else if (path[i] === '..') {
      path.splice(i, 1);
      up++;
    } else if (up) {
      if (i === 0) unshift = true;
      path.splice(i, 1);
      up--;
    }
  }

  if (unshift) path.unshift('');
  if (last === '.' || last === '..') path.push('');

  return path.join('/');
}

/**
 * The actual URL instance. Instead of returning an object we've opted-in to
 * create an actual constructor as it's much more memory efficient and
 * faster and it pleases my OCD.
 *
 * @constructor
 * @param {String} address URL we want to parse.
 * @param {Object|String} location Location defaults for relative paths.
 * @param {Boolean|Function} parser Parser for the query string.
 * @api public
 */
function URL(address, location, parser) {
  if (!(this instanceof URL)) {
    return new URL(address, location, parser);
  }

  var relative, extracted, parse, instruction, index, key
    , instructions = rules.slice()
    , type = typeof location
    , url = this
    , i = 0;

  //
  // The following if statements allows this module two have compatibility with
  // 2 different API:
  //
  // 1. Node.js's `url.parse` api which accepts a URL, boolean as arguments
  //    where the boolean indicates that the query string should also be parsed.
  //
  // 2. The `URL` interface of the browser which accepts a URL, object as
  //    arguments. The supplied object will be used as default values / fall-back
  //    for relative paths.
  //
  if ('object' !== type && 'string' !== type) {
    parser = location;
    location = null;
  }

  if (parser && 'function' !== typeof parser) parser = qs.parse;

  location = lolcation(location);

  //
  // Extract protocol information before running the instructions.
  //
  extracted = extractProtocol(address || '');
  relative = !extracted.protocol && !extracted.slashes;
  url.slashes = extracted.slashes || relative && location.slashes;
  url.protocol = extracted.protocol || location.protocol || '';
  address = extracted.rest;

  //
  // When the authority component is absent the URL starts with a path
  // component.
  //
  if (!extracted.slashes) instructions[2] = [/(.*)/, 'pathname'];

  for (; i < instructions.length; i++) {
    instruction = instructions[i];
    parse = instruction[0];
    key = instruction[1];

    if (parse !== parse) {
      url[key] = address;
    } else if ('string' === typeof parse) {
      if (~(index = address.indexOf(parse))) {
        if ('number' === typeof instruction[2]) {
          url[key] = address.slice(0, index);
          address = address.slice(index + instruction[2]);
        } else {
          url[key] = address.slice(index);
          address = address.slice(0, index);
        }
      }
    } else if (index = parse.exec(address)) {
      url[key] = index[1];
      address = address.slice(0, index.index);
    }

    url[key] = url[key] || (
      relative && instruction[3] ? location[key] || '' : ''
    );

    //
    // Hostname, host and protocol should be lowercased so they can be used to
    // create a proper `origin`.
    //
    if (instruction[4]) url[key] = url[key].toLowerCase();
  }

  //
  // Also parse the supplied query string in to an object. If we're supplied
  // with a custom parser as function use that instead of the default build-in
  // parser.
  //
  if (parser) url.query = parser(url.query);

  //
  // If the URL is relative, resolve the pathname against the base URL.
  //
  if (
      relative
    && location.slashes
    && url.pathname.charAt(0) !== '/'
    && (url.pathname !== '' || location.pathname !== '')
  ) {
    url.pathname = resolve(url.pathname, location.pathname);
  }

  //
  // We should not add port numbers if they are already the default port number
  // for a given protocol. As the host also contains the port number we're going
  // override it with the hostname which contains no port number.
  //
  if (!required(url.port, url.protocol)) {
    url.host = url.hostname;
    url.port = '';
  }

  //
  // Parse down the `auth` for the username and password.
  //
  url.username = url.password = '';
  if (url.auth) {
    instruction = url.auth.split(':');
    url.username = instruction[0] || '';
    url.password = instruction[1] || '';
  }

  url.origin = url.protocol && url.host && url.protocol !== 'file:'
    ? url.protocol +'//'+ url.host
    : 'null';

  //
  // The href is just the compiled result.
  //
  url.href = url.toString();
}

/**
 * This is convenience method for changing properties in the URL instance to
 * insure that they all propagate correctly.
 *
 * @param {String} part          Property we need to adjust.
 * @param {Mixed} value          The newly assigned value.
 * @param {Boolean|Function} fn  When setting the query, it will be the function
 *                               used to parse the query.
 *                               When setting the protocol, double slash will be
 *                               removed from the final url if it is true.
 * @returns {URL}
 * @api public
 */
URL.prototype.set = function set(part, value, fn) {
  var url = this;

  switch (part) {
    case 'query':
      if ('string' === typeof value && value.length) {
        value = (fn || qs.parse)(value);
      }

      url[part] = value;
      break;

    case 'port':
      url[part] = value;

      if (!required(value, url.protocol)) {
        url.host = url.hostname;
        url[part] = '';
      } else if (value) {
        url.host = url.hostname +':'+ value;
      }

      break;

    case 'hostname':
      url[part] = value;

      if (url.port) value += ':'+ url.port;
      url.host = value;
      break;

    case 'host':
      url[part] = value;

      if (/:\d+$/.test(value)) {
        value = value.split(':');
        url.port = value.pop();
        url.hostname = value.join(':');
      } else {
        url.hostname = value;
        url.port = '';
      }

      break;

    case 'protocol':
      url.protocol = value.toLowerCase();
      url.slashes = !fn;
      break;

    case 'pathname':
      url.pathname = value.charAt(0) === '/' ? value : '/' + value;
      break;

    default:
      url[part] = value;
  }

  for (var i = 0; i < rules.length; i++) {
    var ins = rules[i];

    if (ins[4]) url[ins[1]] = url[ins[1]].toLowerCase();
  }

  url.origin = url.protocol && url.host && url.protocol !== 'file:'
    ? url.protocol +'//'+ url.host
    : 'null';

  url.href = url.toString();

  return url;
};

/**
 * Transform the properties back in to a valid and full URL string.
 *
 * @param {Function} stringify Optional query stringify function.
 * @returns {String}
 * @api public
 */
URL.prototype.toString = function toString(stringify) {
  if (!stringify || 'function' !== typeof stringify) stringify = qs.stringify;

  var query
    , url = this
    , protocol = url.protocol;

  if (protocol && protocol.charAt(protocol.length - 1) !== ':') protocol += ':';

  var result = protocol + (url.slashes ? '//' : '');

  if (url.username) {
    result += url.username;
    if (url.password) result += ':'+ url.password;
    result += '@';
  }

  result += url.host + url.pathname;

  query = 'object' === typeof url.query ? stringify(url.query) : url.query;
  if (query) result += '?' !== query.charAt(0) ? '?'+ query : query;

  if (url.hash) result += url.hash;

  return result;
};

//
// Expose the URL parser and some additional properties that might be useful for
// others or testing.
//
URL.extractProtocol = extractProtocol;
URL.location = lolcation;
URL.qs = qs;

module.exports = URL;

},{"./lolcation":13,"querystringify":7,"requires-port":10}],13:[function(_dereq_,module,exports){
(function (global){
'use strict';

var slashes = /^[A-Za-z][A-Za-z0-9+-.]*:\/\//;

/**
 * These properties should not be copied or inherited from. This is only needed
 * for all non blob URL's as a blob URL does not include a hash, only the
 * origin.
 *
 * @type {Object}
 * @private
 */
var ignore = { hash: 1, query: 1 }
  , URL;

/**
 * The location object differs when your code is loaded through a normal page,
 * Worker or through a worker using a blob. And with the blobble begins the
 * trouble as the location object will contain the URL of the blob, not the
 * location of the page where our code is loaded in. The actual origin is
 * encoded in the `pathname` so we can thankfully generate a good "default"
 * location from it so we can generate proper relative URL's again.
 *
 * @param {Object|String} loc Optional default location object.
 * @returns {Object} lolcation object.
 * @api public
 */
module.exports = function lolcation(loc) {
  loc = loc || global.location || {};
  URL = URL || _dereq_('./');

  var finaldestination = {}
    , type = typeof loc
    , key;

  if ('blob:' === loc.protocol) {
    finaldestination = new URL(unescape(loc.pathname), {});
  } else if ('string' === type) {
    finaldestination = new URL(loc, {});
    for (key in ignore) delete finaldestination[key];
  } else if ('object' === type) {
    for (key in loc) {
      if (key in ignore) continue;
      finaldestination[key] = loc[key];
    }

    if (finaldestination.slashes === undefined) {
      finaldestination.slashes = slashes.test(loc.href);
    }
  }

  return finaldestination;
};

}).call(this,typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"./":12}],14:[function(_dereq_,module,exports){
'use strict';

var alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_'.split('')
  , length = 64
  , map = {}
  , seed = 0
  , i = 0
  , prev;

/**
 * Return a string representing the specified number.
 *
 * @param {Number} num The number to convert.
 * @returns {String} The string representation of the number.
 * @api public
 */
function encode(num) {
  var encoded = '';

  do {
    encoded = alphabet[num % length] + encoded;
    num = Math.floor(num / length);
  } while (num > 0);

  return encoded;
}

/**
 * Return the integer value specified by the given string.
 *
 * @param {String} str The string to convert.
 * @returns {Number} The integer value represented by the string.
 * @api public
 */
function decode(str) {
  var decoded = 0;

  for (i = 0; i < str.length; i++) {
    decoded = decoded * length + map[str.charAt(i)];
  }

  return decoded;
}

/**
 * Yeast: A tiny growing id generator.
 *
 * @returns {String} A unique id.
 * @api public
 */
function yeast() {
  var now = encode(+new Date());

  if (now !== prev) return seed = 0, prev = now;
  return now +'.'+ encode(seed++);
}

//
// Map each character to its index.
//
for (; i < length; i++) map[alphabet[i]] = i;

//
// Expose the `yeast`, `encode` and `decode` functions.
//
yeast.encode = encode;
yeast.decode = decode;
module.exports = yeast;

},{}],15:[function(_dereq_,module,exports){
/*globals require, define */
'use strict';

var EventEmitter = _dereq_('eventemitter3')
  , TickTock = _dereq_('tick-tock')
  , Recovery = _dereq_('recovery')
  , qs = _dereq_('querystringify')
  , inherits = _dereq_('inherits')
  , destroy = _dereq_('demolish')
  , yeast = _dereq_('yeast')
  , u2028 = /\u2028/g
  , u2029 = /\u2029/g;

/**
 * Context assertion, ensure that some of our public Primus methods are called
 * with the correct context to ensure that
 *
 * @param {Primus} self The context of the function.
 * @param {String} method The method name.
 * @api private
 */
function context(self, method) {
  if (self instanceof Primus) return;

  var failure = new Error('Primus#'+ method + '\'s context should called with a Primus instance');

  if ('function' !== typeof self.listeners || !self.listeners('error').length) {
    throw failure;
  }

  self.emit('error', failure);
}

//
// Sets the default connection URL, it uses the default origin of the browser
// when supported but degrades for older browsers. In Node.js, we cannot guess
// where the user wants to connect to, so we just default to localhost.
//
var defaultUrl;

try {
  if (location.origin) {
    defaultUrl = location.origin;
  } else {
    defaultUrl = location.protocol +'//'+ location.host;
  }
} catch (e) {
  defaultUrl = 'http://127.0.0.1';
}

/**
 * Primus is a real-time library agnostic framework for establishing real-time
 * connections with servers.
 *
 * Options:
 * - reconnect, configuration for the reconnect process.
 * - manual, don't automatically call `.open` to start the connection.
 * - websockets, force the use of WebSockets, even when you should avoid them.
 * - timeout, connect timeout, server didn't respond in a timely manner.
 * - ping, The heartbeat interval for sending a ping packet to the server.
 * - pong, The heartbeat timeout for receiving a response to the ping.
 * - network, Use network events as leading method for network connection drops.
 * - strategy, Reconnection strategies.
 * - transport, Transport options.
 * - url, uri, The URL to use connect with the server.
 *
 * @constructor
 * @param {String} url The URL of your server.
 * @param {Object} options The configuration.
 * @api public
 */
function Primus(url, options) {
  if (!(this instanceof Primus)) return new Primus(url, options);

  Primus.Stream.call(this);

  if ('function' !== typeof this.client) {
    var message = 'The client library has not been compiled correctly, ' +
      'see https://github.com/primus/primus#client-library for more details';
    return this.critical(new Error(message));
  }

  if ('object' === typeof url) {
    options = url;
    url = options.url || options.uri || defaultUrl;
  } else {
    options = options || {};
  }

  var primus = this;

  // The maximum number of messages that can be placed in queue.
  options.queueSize = 'queueSize' in options ? options.queueSize : Infinity;

  // Connection timeout duration.
  options.timeout = 'timeout' in options ? options.timeout : 10e3;

  // Stores the back off configuration.
  options.reconnect = 'reconnect' in options ? options.reconnect : {};

  // Heartbeat ping interval.
  options.ping = 'ping' in options ? options.ping : 25000;

  // Heartbeat pong response timeout.
  options.pong = 'pong' in options ? options.pong : 10e3;

  // Reconnect strategies.
  options.strategy = 'strategy' in options ? options.strategy : [];

  // Custom transport options.
  options.transport = 'transport' in options ? options.transport : {};

  primus.buffer = [];                           // Stores premature send data.
  primus.writable = true;                       // Silly stream compatibility.
  primus.readable = true;                       // Silly stream compatibility.
  primus.url = primus.parse(url || defaultUrl); // Parse the URL to a readable format.
  primus.readyState = Primus.CLOSED;            // The readyState of the connection.
  primus.options = options;                     // Reference to the supplied options.
  primus.timers = new TickTock(this);           // Contains all our timers.
  primus.socket = null;                         // Reference to the internal connection.
  primus.latency = 0;                           // Latency between messages.
  primus.disconnect = false;                    // Did we receive a disconnect packet?
  primus.transport = options.transport;         // Transport options.
  primus.transformers = {                       // Message transformers.
    outgoing: [],
    incoming: []
  };

  //
  // Create our reconnection instance.
  //
  primus.recovery = new Recovery(options.reconnect);

  //
  // Parse the reconnection strategy. It can have the following strategies:
  //
  // - timeout: Reconnect when we have a network timeout.
  // - disconnect: Reconnect when we have an unexpected disconnect.
  // - online: Reconnect when we're back online.
  //
  if ('string' === typeof options.strategy) {
    options.strategy = options.strategy.split(/\s?\,\s?/g);
  }

  if (false === options.strategy) {
    //
    // Strategies are disabled, but we still need an empty array to join it in
    // to nothing.
    //
    options.strategy = [];
  } else if (!options.strategy.length) {
    options.strategy.push('disconnect', 'online');

    //
    // Timeout based reconnection should only be enabled conditionally. When
    // authorization is enabled it could trigger.
    //
    if (!this.authorization) options.strategy.push('timeout');
  }

  options.strategy = options.strategy.join(',').toLowerCase();

  //
  // Force the use of WebSockets, even when we've detected some potential
  // broken WebSocket implementation.
  //
  if ('websockets' in options) {
    primus.AVOID_WEBSOCKETS = !options.websockets;
  }

  //
  // Force or disable the use of NETWORK events as leading client side
  // disconnection detection.
  //
  if ('network' in options) {
    primus.NETWORK_EVENTS = options.network;
  }

  //
  // Check if the user wants to manually initialise a connection. If they don't,
  // we want to do it after a really small timeout so we give the users enough
  // time to listen for `error` events etc.
  //
  if (!options.manual) primus.timers.setTimeout('open', function open() {
    primus.timers.clear('open');
    primus.open();
  }, 0);

  primus.initialise(options);
}

/**
 * Simple require wrapper to make browserify, node and require.js play nice.
 *
 * @param {String} name The module to require.
 * @returns {Object|Undefined} The module that we required.
 * @api private
 */
Primus.requires = Primus.require = function requires(name) {
  if ('function' !== typeof _dereq_) return undefined;

  return !('function' === typeof define && define.amd)
    ? _dereq_(name)
    : undefined;
};

//
// It's possible that we're running in Node.js or in a Node.js compatible
// environment. In this cases we try to inherit from the Stream base class.
//
try {
  Primus.Stream = Primus.requires('stream');
} catch (e) { }

if (!Primus.Stream) Primus.Stream = EventEmitter;

inherits(Primus, Primus.Stream);

/**
 * Primus readyStates, used internally to set the correct ready state.
 *
 * @type {Number}
 * @private
 */
Primus.OPENING = 1;   // We're opening the connection.
Primus.CLOSED  = 2;   // No active connection.
Primus.OPEN    = 3;   // The connection is open.

/**
 * Are we working with a potentially broken WebSockets implementation? This
 * boolean can be used by transformers to remove `WebSockets` from their
 * supported transports.
 *
 * @type {Boolean}
 * @private
 */
Primus.prototype.AVOID_WEBSOCKETS = false;

/**
 * Some browsers support registering emitting `online` and `offline` events when
 * the connection has been dropped on the client. We're going to detect it in
 * a simple `try {} catch (e) {}` statement so we don't have to do complicated
 * feature detection.
 *
 * @type {Boolean}
 * @private
 */
Primus.prototype.NETWORK_EVENTS = false;
Primus.prototype.online = true;

try {
  if (
       Primus.prototype.NETWORK_EVENTS = 'onLine' in navigator
    && (window.addEventListener || document.body.attachEvent)
  ) {
    if (!navigator.onLine) {
      Primus.prototype.online = false;
    }
  }
} catch (e) { }

/**
 * The Ark contains all our plugins definitions. It's namespaced by
 * name => plugin.
 *
 * @type {Object}
 * @private
 */
Primus.prototype.ark = {};

/**
 * Simple emit wrapper that returns a function that emits an event once it's
 * called. This makes it easier for transports to emit specific events.
 *
 * @returns {Function} A function that will emit the event when called.
 * @api public
 */
Primus.prototype.emits = _dereq_('emits');

/**
 * Return the given plugin.
 *
 * @param {String} name The name of the plugin.
 * @returns {Object|undefined} The plugin or undefined.
 * @api public
 */
Primus.prototype.plugin = function plugin(name) {
  context(this, 'plugin');

  if (name) return this.ark[name];

  var plugins = {};

  for (name in this.ark) {
    plugins[name] = this.ark[name];
  }

  return plugins;
};

/**
 * Checks if the given event is an emitted event by Primus.
 *
 * @param {String} evt The event name.
 * @returns {Boolean} Indication of the event is reserved for internal use.
 * @api public
 */
Primus.prototype.reserved = function reserved(evt) {
  return (/^(incoming|outgoing)::/).test(evt)
  || evt in this.reserved.events;
};

/**
 * The actual events that are used by the client.
 *
 * @type {Object}
 * @public
 */
Primus.prototype.reserved.events = {
  'reconnect scheduled': 1,
  'reconnect timeout': 1,
  'readyStateChange': 1,
  'reconnect failed': 1,
  'reconnected': 1,
  'reconnect': 1,
  'offline': 1,
  'timeout': 1,
  'online': 1,
  'error': 1,
  'close': 1,
  'open': 1,
  'data': 1,
  'end': 1
};

/**
 * Initialise the Primus and setup all parsers and internal listeners.
 *
 * @param {Object} options The original options object.
 * @returns {Primus}
 * @api private
 */
Primus.prototype.initialise = function initialise(options) {
  var primus = this
    , start;

  primus.recovery
  .on('reconnected', primus.emits('reconnected'))
  .on('reconnect failed', primus.emits('reconnect failed', function failed(next) {
    primus.emit('end');
    next();
  }))
  .on('reconnect timeout', primus.emits('reconnect timeout'))
  .on('reconnect scheduled', primus.emits('reconnect scheduled'))
  .on('reconnect', primus.emits('reconnect', function reconnect(next) {
    primus.emit('outgoing::reconnect');
    next();
  }));

  primus.on('outgoing::open', function opening() {
    var readyState = primus.readyState;

    primus.readyState = Primus.OPENING;
    if (readyState !== primus.readyState) {
      primus.emit('readyStateChange', 'opening');
    }

    start = +new Date();
  });

  primus.on('incoming::open', function opened() {
    var readyState = primus.readyState;

    if (primus.recovery.reconnecting()) {
      primus.recovery.reconnected();
    }

    //
    // The connection has been opened so we should set our state to
    // (writ|read)able so our stream compatibility works as intended.
    //
    primus.writable = true;
    primus.readable = true;

    //
    // Make sure we are flagged as `online` as we've successfully opened the
    // connection.
    //
    if (!primus.online) {
      primus.online = true;
      primus.emit('online');
    }

    primus.readyState = Primus.OPEN;
    if (readyState !== primus.readyState) {
      primus.emit('readyStateChange', 'open');
    }

    primus.latency = +new Date() - start;
    primus.timers.clear('ping', 'pong');
    primus.heartbeat();

    if (primus.buffer.length) {
      var data = primus.buffer.slice()
        , length = data.length
        , i = 0;

      primus.buffer.length = 0;

      for (; i < length; i++) {
        primus._write(data[i]);
      }
    }

    primus.emit('open');
  });

  primus.on('incoming::pong', function pong(time) {
    primus.online = true;
    primus.timers.clear('pong');
    primus.heartbeat();

    primus.latency = (+new Date()) - time;
  });

  primus.on('incoming::error', function error(e) {
    var connect = primus.timers.active('connect')
      , err = e;

    //
    // When the error is not an Error instance we try to normalize it.
    //
    if ('string' === typeof e) {
      err = new Error(e);
    } else if (!(e instanceof Error) && 'object' === typeof e) {
      //
      // BrowserChannel and SockJS returns an object which contains some
      // details of the error. In order to have a proper error we "copy" the
      // details in an Error instance.
      //
      err = new Error(e.message || e.reason);
      for (var key in e) {
        if (Object.prototype.hasOwnProperty.call(e, key))
          err[key] = e[key];
      }
    }
    //
    // We're still doing a reconnect attempt, it could be that we failed to
    // connect because the server was down. Failing connect attempts should
    // always emit an `error` event instead of a `open` event.
    //
    //
    if (primus.recovery.reconnecting()) return primus.recovery.reconnected(err);
    if (primus.listeners('error').length) primus.emit('error', err);

    //
    // We received an error while connecting, this most likely the result of an
    // unauthorized access to the server.
    //
    if (connect) {
      if (~primus.options.strategy.indexOf('timeout')) {
        primus.recovery.reconnect();
      } else {
        primus.end();
      }
    }
  });

  primus.on('incoming::data', function message(raw) {
    primus.decoder(raw, function decoding(err, data) {
      //
      // Do a "safe" emit('error') when we fail to parse a message. We don't
      // want to throw here as listening to errors should be optional.
      //
      if (err) return primus.listeners('error').length && primus.emit('error', err);

      //
      // Handle all "primus::" prefixed protocol messages.
      //
      if (primus.protocol(data)) return;
      primus.transforms(primus, primus, 'incoming', data, raw);
    });
  });

  primus.on('incoming::end', function end() {
    var readyState = primus.readyState;

    //
    // This `end` started with the receiving of a primus::server::close packet
    // which indicated that the user/developer on the server closed the
    // connection and it was not a result of a network disruption. So we should
    // kill the connection without doing a reconnect.
    //
    if (primus.disconnect) {
      primus.disconnect = false;

      return primus.end();
    }

    //
    // Always set the readyState to closed, and if we're still connecting, close
    // the connection so we're sure that everything after this if statement block
    // is only executed because our readyState is set to `open`.
    //
    primus.readyState = Primus.CLOSED;
    if (readyState !== primus.readyState) {
      primus.emit('readyStateChange', 'end');
    }

    if (primus.timers.active('connect')) primus.end();
    if (readyState !== Primus.OPEN) {
      return primus.recovery.reconnecting()
        ? primus.recovery.reconnect()
        : false;
    }

    this.writable = false;
    this.readable = false;

    //
    // Clear all timers in case we're not going to reconnect.
    //
    this.timers.clear();

    //
    // Fire the `close` event as an indication of connection disruption.
    // This is also fired by `primus#end` so it is emitted in all cases.
    //
    primus.emit('close');

    //
    // The disconnect was unintentional, probably because the server has
    // shutdown, so if the reconnection is enabled start a reconnect procedure.
    //
    if (~primus.options.strategy.indexOf('disconnect')) {
      return primus.recovery.reconnect();
    }

    primus.emit('outgoing::end');
    primus.emit('end');
  });

  //
  // Setup the real-time client.
  //
  primus.client();

  //
  // Process the potential plugins.
  //
  for (var plugin in primus.ark) {
    primus.ark[plugin].call(primus, primus, options);
  }

  //
  // NOTE: The following code is only required if we're supporting network
  // events as it requires access to browser globals.
  //
  if (!primus.NETWORK_EVENTS) return primus;

  /**
   * Handler for offline notifications.
   *
   * @api private
   */
  primus.offlineHandler = function offline() {
    if (!primus.online) return; // Already or still offline, bailout.

    primus.online = false;
    primus.emit('offline');
    primus.end();

    //
    // It is certainly possible that we're in a reconnection loop and that the
    // user goes offline. In this case we want to kill the existing attempt so
    // when the user goes online, it will attempt to reconnect freshly again.
    //
    primus.recovery.reset();
  };

  /**
   * Handler for online notifications.
   *
   * @api private
   */
  primus.onlineHandler = function online() {
    if (primus.online) return; // Already or still online, bailout.

    primus.online = true;
    primus.emit('online');

    if (~primus.options.strategy.indexOf('online')) {
      primus.recovery.reconnect();
    }
  };

  if (window.addEventListener) {
    window.addEventListener('offline', primus.offlineHandler, false);
    window.addEventListener('online', primus.onlineHandler, false);
  } else if (document.body.attachEvent){
    document.body.attachEvent('onoffline', primus.offlineHandler);
    document.body.attachEvent('ononline', primus.onlineHandler);
  }

  return primus;
};

/**
 * Really dead simple protocol parser. We simply assume that every message that
 * is prefixed with `primus::` could be used as some sort of protocol definition
 * for Primus.
 *
 * @param {String} msg The data.
 * @returns {Boolean} Is a protocol message.
 * @api private
 */
Primus.prototype.protocol = function protocol(msg) {
  if (
       'string' !== typeof msg
    || msg.indexOf('primus::') !== 0
  ) return false;

  var last = msg.indexOf(':', 8)
    , value = msg.slice(last + 2);

  switch (msg.slice(8,  last)) {
    case 'pong':
      this.emit('incoming::pong', +value);
    break;

    case 'server':
      //
      // The server is closing the connection, forcefully disconnect so we don't
      // reconnect again.
      //
      if ('close' === value) {
        this.disconnect = true;
      }
    break;

    case 'id':
      this.emit('incoming::id', value);
    break;

    //
    // Unknown protocol, somebody is probably sending `primus::` prefixed
    // messages.
    //
    default:
      return false;
  }

  return true;
};

/**
 * Execute the set of message transformers from Primus on the incoming or
 * outgoing message.
 * This function and it's content should be in sync with Spark#transforms in
 * spark.js.
 *
 * @param {Primus} primus Reference to the Primus instance with message transformers.
 * @param {Spark|Primus} connection Connection that receives or sends data.
 * @param {String} type The type of message, 'incoming' or 'outgoing'.
 * @param {Mixed} data The data to send or that has been received.
 * @param {String} raw The raw encoded data.
 * @returns {Primus}
 * @api public
 */
Primus.prototype.transforms = function transforms(primus, connection, type, data, raw) {
  var packet = { data: data }
    , fns = primus.transformers[type];

  //
  // Iterate in series over the message transformers so we can allow optional
  // asynchronous execution of message transformers which could for example
  // retrieve additional data from the server, do extra decoding or even
  // message validation.
  //
  (function transform(index, done) {
    var transformer = fns[index++];

    if (!transformer) return done();

    if (1 === transformer.length) {
      if (false === transformer.call(connection, packet)) {
        //
        // When false is returned by an incoming transformer it means that's
        // being handled by the transformer and we should not emit the `data`
        // event.
        //
        return;
      }

      return transform(index, done);
    }

    transformer.call(connection, packet, function finished(err, arg) {
      if (err) return connection.emit('error', err);
      if (false === arg) return;

      transform(index, done);
    });
  }(0, function done() {
    //
    // We always emit 2 arguments for the data event, the first argument is the
    // parsed data and the second argument is the raw string that we received.
    // This allows you, for example, to do some validation on the parsed data
    // and then save the raw string in your database without the stringify
    // overhead.
    //
    if ('incoming' === type) return connection.emit('data', packet.data, raw);

    connection._write(packet.data);
  }));

  return this;
};

/**
 * Retrieve the current id from the server.
 *
 * @param {Function} fn Callback function.
 * @returns {Primus}
 * @api public
 */
Primus.prototype.id = function id(fn) {
  if (this.socket && this.socket.id) return fn(this.socket.id);

  this._write('primus::id::');
  return this.once('incoming::id', fn);
};

/**
 * Establish a connection with the server. When this function is called we
 * assume that we don't have any open connections. If you do call it when you
 * have a connection open, it could cause duplicate connections.
 *
 * @returns {Primus}
 * @api public
 */
Primus.prototype.open = function open() {
  context(this, 'open');

  //
  // Only start a `connection timeout` procedure if we're not reconnecting as
  // that shouldn't count as an initial connection. This should be started
  // before the connection is opened to capture failing connections and kill the
  // timeout.
  //
  if (!this.recovery.reconnecting() && this.options.timeout) this.timeout();

  this.emit('outgoing::open');
  return this;
};

/**
 * Send a new message.
 *
 * @param {Mixed} data The data that needs to be written.
 * @returns {Boolean} Always returns true as we don't support back pressure.
 * @api public
 */
Primus.prototype.write = function write(data) {
  context(this, 'write');
  this.transforms(this, this, 'outgoing', data);

  return true;
};

/**
 * The actual message writer.
 *
 * @param {Mixed} data The message that needs to be written.
 * @returns {Boolean} Successful write to the underlaying transport.
 * @api private
 */
Primus.prototype._write = function write(data) {
  var primus = this;

  //
  // The connection is closed, normally this would already be done in the
  // `spark.write` method, but as `_write` is used internally, we should also
  // add the same check here to prevent potential crashes by writing to a dead
  // socket.
  //
  if (Primus.OPEN !== primus.readyState) {
    //
    // If the buffer is at capacity, remove the first item.
    //
    if (this.buffer.length === this.options.queueSize) {
      this.buffer.splice(0, 1);
    }

    this.buffer.push(data);
    return false;
  }

  primus.encoder(data, function encoded(err, packet) {
    //
    // Do a "safe" emit('error') when we fail to parse a message. We don't
    // want to throw here as listening to errors should be optional.
    //
    if (err) return primus.listeners('error').length && primus.emit('error', err);

    //
    // Hack 1: \u2028 and \u2029 are allowed inside a JSON string, but JavaScript
    // defines them as newline separators. Unescaped control characters are not
    // allowed inside JSON strings, so this causes an error at parse time. We
    // work around this issue by escaping these characters. This can cause
    // errors with JSONP requests or if the string is just evaluated.
    //
    if ('string' === typeof packet) {
      if (~packet.indexOf('\u2028')) packet = packet.replace(u2028, '\\u2028');
      if (~packet.indexOf('\u2029')) packet = packet.replace(u2029, '\\u2029');
    }

    primus.emit('outgoing::data', packet);
  });

  return true;
};

/**
 * Send a new heartbeat over the connection to ensure that we're still
 * connected and our internet connection didn't drop. We cannot use server side
 * heartbeats for this unfortunately.
 *
 * @returns {Primus}
 * @api private
 */
Primus.prototype.heartbeat = function heartbeat() {
  var primus = this;

  if (!primus.options.ping) return primus;

  /**
   * Exterminate the connection as we've timed out.
   *
   * @api private
   */
  function pong() {
    primus.timers.clear('pong');

    //
    // The network events already captured the offline event.
    //
    if (!primus.online) return;

    primus.online = false;
    primus.emit('offline');
    primus.emit('incoming::end');
  }

  /**
   * We should send a ping message to the server.
   *
   * @api private
   */
  function ping() {
    var value = +new Date();

    primus.timers.clear('ping');
    primus._write('primus::ping::'+ value);
    primus.emit('outgoing::ping', value);
    primus.timers.setTimeout('pong', pong, primus.options.pong);
  }

  primus.timers.setTimeout('ping', ping, primus.options.ping);
  return this;
};

/**
 * Start a connection timeout.
 *
 * @returns {Primus}
 * @api private
 */
Primus.prototype.timeout = function timeout() {
  var primus = this;

  /**
   * Remove all references to the timeout listener as we've received an event
   * that can be used to determine state.
   *
   * @api private
   */
  function remove() {
    primus.removeListener('error', remove)
          .removeListener('open', remove)
          .removeListener('end', remove)
          .timers.clear('connect');
  }

  primus.timers.setTimeout('connect', function expired() {
    remove(); // Clean up old references.

    if (primus.readyState === Primus.OPEN || primus.recovery.reconnecting()) {
      return;
    }

    primus.emit('timeout');

    //
    // We failed to connect to the server.
    //
    if (~primus.options.strategy.indexOf('timeout')) {
      primus.recovery.reconnect();
    } else {
      primus.end();
    }
  }, primus.options.timeout);

  return primus.on('error', remove)
    .on('open', remove)
    .on('end', remove);
};

/**
 * Close the connection completely.
 *
 * @param {Mixed} data last packet of data.
 * @returns {Primus}
 * @api public
 */
Primus.prototype.end = function end(data) {
  context(this, 'end');

  if (
      this.readyState === Primus.CLOSED
    && !this.timers.active('connect')
    && !this.timers.active('open')
  ) {
    //
    // If we are reconnecting stop the reconnection procedure.
    //
    if (this.recovery.reconnecting()) {
      this.recovery.reset();
      this.emit('end');
    }

    return this;
  }

  if (data !== undefined) this.write(data);

  this.writable = false;
  this.readable = false;

  var readyState = this.readyState;
  this.readyState = Primus.CLOSED;

  if (readyState !== this.readyState) {
    this.emit('readyStateChange', 'end');
  }

  this.timers.clear();
  this.emit('outgoing::end');
  this.emit('close');
  this.emit('end');

  return this;
};

/**
 * Completely demolish the Primus instance and forcefully nuke all references.
 *
 * @returns {Boolean}
 * @api public
 */
Primus.prototype.destroy = destroy('url timers options recovery socket transport transformers', {
  before: 'end',
  after: ['removeAllListeners', function detach() {
    if (!this.NETWORK_EVENTS) return;

    if (window.addEventListener) {
      window.removeEventListener('offline', this.offlineHandler);
      window.removeEventListener('online', this.onlineHandler);
    } else if (document.body.attachEvent){
      document.body.detachEvent('onoffline', this.offlineHandler);
      document.body.detachEvent('ononline', this.onlineHandler);
    }
  }]
});

/**
 * Create a shallow clone of a given object.
 *
 * @param {Object} obj The object that needs to be cloned.
 * @returns {Object} Copy.
 * @api private
 */
Primus.prototype.clone = function clone(obj) {
  return this.merge({}, obj);
};

/**
 * Merge different objects in to one target object.
 *
 * @param {Object} target The object where everything should be merged in.
 * @returns {Object} Original target with all merged objects.
 * @api private
 */
Primus.prototype.merge = function merge(target) {
  for (var i = 1, key, obj; i < arguments.length; i++) {
    obj = arguments[i];

    for (key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key))
        target[key] = obj[key];
    }
  }

  return target;
};

/**
 * Parse the connection string.
 *
 * @type {Function}
 * @param {String} url Connection URL.
 * @returns {Object} Parsed connection.
 * @api private
 */
Primus.prototype.parse = _dereq_('url-parse');

/**
 * Parse a query string.
 *
 * @param {String} query The query string that needs to be parsed.
 * @returns {Object} Parsed query string.
 * @api private
 */
Primus.prototype.querystring = qs.parse;
/**
 * Transform a query string object back into string equiv.
 *
 * @param {Object} obj The query string object.
 * @returns {String}
 * @api private
 */
Primus.prototype.querystringify = qs.stringify;

/**
 * Generates a connection URI.
 *
 * @param {String} protocol The protocol that should used to crate the URI.
 * @returns {String|options} The URL.
 * @api private
 */
Primus.prototype.uri = function uri(options) {
  var url = this.url
    , server = []
    , qsa = false;

  //
  // Query strings are only allowed when we've received clearance for it.
  //
  if (options.query) qsa = true;

  options = options || {};
  options.protocol = 'protocol' in options
    ? options.protocol
    : 'http:';
  options.query = url.query && qsa
    ? url.query.slice(1)
    : false;
  options.secure = 'secure' in options
    ? options.secure
    : url.protocol === 'https:' || url.protocol === 'wss:';
  options.auth = 'auth' in options
    ? options.auth
    : url.auth;
  options.pathname = 'pathname' in options
    ? options.pathname
    : this.pathname;
  options.port = 'port' in options
    ? +options.port
    : +url.port || (options.secure ? 443 : 80);

  //
  // Allow transformation of the options before we construct a full URL from it.
  //
  this.emit('outgoing::url', options);

  //
  // We need to make sure that we create a unique connection URL every time to
  // prevent back forward cache from becoming an issue. We're doing this by
  // forcing an cache busting query string in to the URL.
  //
  var querystring = this.querystring(options.query || '');
  querystring._primuscb = yeast();
  options.query = this.querystringify(querystring);

  //
  // Automatically suffix the protocol so we can supply `ws:` and `http:` and
  // it gets transformed correctly.
  //
  server.push(options.secure ? options.protocol.replace(':', 's:') : options.protocol, '');

  server.push(options.auth ? options.auth +'@'+ url.host : url.host);

  //
  // Pathnames are optional as some Transformers would just use the pathname
  // directly.
  //
  if (options.pathname) server.push(options.pathname.slice(1));

  //
  // Optionally add a search query.
  //
  if (qsa) server[server.length - 1] += '?'+ options.query;
  else delete options.query;

  if (options.object) return options;
  return server.join('/');
};

/**
 * Register a new message transformer. This allows you to easily manipulate incoming
 * and outgoing data which is particularity handy for plugins that want to send
 * meta data together with the messages.
 *
 * @param {String} type Incoming or outgoing
 * @param {Function} fn A new message transformer.
 * @returns {Primus}
 * @api public
 */
Primus.prototype.transform = function transform(type, fn) {
  context(this, 'transform');

  if (!(type in this.transformers)) {
    return this.critical(new Error('Invalid transformer type'));
  }

  this.transformers[type].push(fn);
  return this;
};

/**
 * A critical error has occurred, if we have an `error` listener, emit it there.
 * If not, throw it, so we get a stack trace + proper error message.
 *
 * @param {Error} err The critical error.
 * @returns {Primus}
 * @api private
 */
Primus.prototype.critical = function critical(err) {
  if (this.listeners('error').length) {
    this.emit('error', err);
    return this;
  }

  throw err;
};

/**
 * Syntax sugar, adopt a Socket.IO like API.
 *
 * @param {String} url The URL we want to connect to.
 * @param {Object} options Connection options.
 * @returns {Primus}
 * @api public
 */
Primus.connect = function connect(url, options) {
  return new Primus(url, options);
};

//
// Expose the EventEmitter so it can be re-used by wrapping libraries we're also
// exposing the Stream interface.
//
Primus.EventEmitter = EventEmitter;

//
// These libraries are automatically inserted at the server-side using the
// Primus#library method.
//
Primus.prototype.client = function client() {
  var primus = this
    , socket;

  //
  // Select an available WebSocket factory.
  //
  var Factory = (function factory() {
    if ('undefined' !== typeof WebSocket) return WebSocket;
    if ('undefined' !== typeof MozWebSocket) return MozWebSocket;

    try { return Primus.requires('ws'); }
    catch (e) {}

    return undefined;
  })();

  if (!Factory) return primus.critical(new Error(
    'Missing required `ws` module. Please run `npm install --save ws`'
  ));

  //
  // Connect to the given URL.
  //
  primus.on('outgoing::open', function opening() {
    primus.emit('outgoing::end');

    //
    // FireFox will throw an error when we try to establish a connection from
    // a secure page to an unsecured WebSocket connection. This is inconsistent
    // behaviour between different browsers. This should ideally be solved in
    // Primus when we connect.
    //
    try {
      var prot = primus.url.protocol === 'ws+unix:' ? 'ws+unix:' : 'ws:'
        , qsa = prot === 'ws:';

      //
      // Only allow primus.transport object in Node.js, it will throw in
      // browsers with a TypeError if we supply to much arguments.
      //
      if (Factory.length === 3) {
        primus.socket = socket = new Factory(
          primus.uri({ protocol: prot, query: qsa }),   // URL
          [],                                           // Sub protocols
          primus.transport                              // options.
        );
      } else {
        primus.socket = socket = new Factory(primus.uri({
          protocol: prot,
          query: qsa
        }));

        socket.binaryType = 'arraybuffer';
      }
    } catch (e) { return primus.emit('error', e); }

    //
    // Setup the Event handlers.
    //
    socket.onopen = primus.emits('incoming::open');
    socket.onerror = primus.emits('incoming::error');
    socket.onclose = primus.emits('incoming::end');
    socket.onmessage = primus.emits('incoming::data', function parse(next, evt) {
      next(undefined, evt.data);
    });
  });

  //
  // We need to write a new message to the socket.
  //
  primus.on('outgoing::data', function write(message) {
    if (!socket || socket.readyState !== Factory.OPEN) return;

    try { socket.send(message); }
    catch (e) { primus.emit('incoming::error', e); }
  });

  //
  // Attempt to reconnect the socket.
  //
  primus.on('outgoing::reconnect', function reconnect() {
    primus.emit('outgoing::open');
  });

  //
  // We need to close the socket.
  //
  primus.on('outgoing::end', function close() {
    if (!socket) return;

    socket.onerror = socket.onopen = socket.onclose = socket.onmessage = function () {};
    socket.close();
    socket = null;
  });
};
Primus.prototype.authorization = false;
Primus.prototype.pathname = "/primus";
Primus.prototype.encoder = function encoder(data, fn) {
  var err;

  try { data = JSON.stringify(data); }
  catch (e) { err = e; }

  fn(err, data);
};
Primus.prototype.decoder = function decoder(data, fn) {
  var err;

  if ('string' !== typeof data) return fn(err, data);

  try { data = JSON.parse(data); }
  catch (e) { err = e; }

  fn(err, data);
};
Primus.prototype.version = "6.0.5";

if (
     'undefined' !== typeof document
  && 'undefined' !== typeof navigator
) {
  //
  // Hack 2: If you press ESC in FireFox it will close all active connections.
  // Normally this makes sense, when your page is still loading. But versions
  // before FireFox 22 will close all connections including WebSocket connections
  // after page load. One way to prevent this is to do a `preventDefault()` and
  // cancel the operation before it bubbles up to the browsers default handler.
  // It needs to be added as `keydown` event, if it's added keyup it will not be
  // able to prevent the connection from being closed.
  //
  if (document.addEventListener) {
    document.addEventListener('keydown', function keydown(e) {
      if (e.keyCode !== 27 || !e.preventDefault) return;

      e.preventDefault();
    }, false);
  }

  //
  // Hack 3: This is a Mac/Apple bug only, when you're behind a reverse proxy or
  // have you network settings set to `automatic proxy discovery` the safari
  // browser will crash when the WebSocket constructor is initialised. There is
  // no way to detect the usage of these proxies available in JavaScript so we
  // need to do some nasty browser sniffing. This only affects Safari versions
  // lower then 5.1.4
  //
  var ua = (navigator.userAgent || '').toLowerCase()
    , parsed = ua.match(/.+(?:rv|it|ra|ie)[\/: ](\d+)\.(\d+)(?:\.(\d+))?/) || []
    , version = +[parsed[1], parsed[2]].join('.');

  if (
       !~ua.indexOf('chrome')
    && ~ua.indexOf('safari')
    && version < 534.54
  ) {
    Primus.prototype.AVOID_WEBSOCKETS = true;
  }
}

//
// Expose the library.
//
module.exports = Primus;

},{"demolish":1,"emits":2,"eventemitter3":3,"inherits":4,"querystringify":7,"recovery":8,"tick-tock":11,"url-parse":12,"yeast":14}]},{},[15])(15);
  return Primus;
},
[

]);