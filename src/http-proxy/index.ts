// @ts-ignore
import { _extend as extend } from "util";
import { parse as parse_url } from "url";
import { EventEmitter as EE3 } from "eventemitter3";
import http from "http";
import https from "https";
import web from "./passes/web-incoming";
import ws from "./passes/ws-incoming";
import { proxyOptions } from "../index";

type callProxy = (req: http.IncomingMessage, res: http.ServerResponse, options?: proxyOptions) => void;

export class ProxyServer extends EE3 {
  web: callProxy
  ws: callProxy
  proxyRequest: callProxy
  proxyWebsocketRequest: callProxy
  options: proxyOptions
  webPasses
  wsPasses
  _server: https.Server | http.Server
  constructor(options: proxyOptions) {
    super();
    options = options || {};
    options.prependPath = options.prependPath === false ? false : true;

    this.web = this.proxyRequest = this.createRightProxy('web');
    this.ws = this.proxyWebsocketRequest = this.createRightProxy('ws')
    this.options = options;

    this.webPasses = Object.keys(web).map(function(pass) {
      return web[pass];
    });

    this.wsPasses = Object.keys(ws).map(function(pass) {
      return ws[pass];
    });

    this.on('error', this.onError, this);
  }

  onError(err) {
    if (this.listeners('error').length === 1) {
      throw err;
    }
  }

  listen(port, hostname) {
    const self = this;
    const closure = function(req, res) {
      self.web(req, res);
    };

    this._server = this.options.ssl
      ? https.createServer(this.options.ssl , closure)
      : http.createServer(closure);

    if (this.options.ws) {
      this._server.on('upgrade', function(req, socket, head) {
        // @ts-ignore
        self.ws(req, socket, head);
      });
    }

    this._server.listen(port, hostname);
  }

  close(callback) {
    const self = this;
    if (this._server) {
      this._server.close(done);
    }

    function done() {
      self._server = null;
      if (callback) {
        callback.apply(null, arguments);
      }
    }
  }

  before(type, passName, callback) {
    if (type !== 'ws' && type !== 'web') {
      throw new Error('type must be `web` or `ws`');
    }
    const passes = type === 'ws' ? this.wsPasses : this.webPasses;
    let i = false;

    passes.forEach(function(v, idx) {
      if (v.name === passName) i = idx;
    });

    if (i === false) throw new Error('No such pass');

    passes.splice(i, 0, callback);
  }

  after(type, passName, callback) {
    if (type !== 'ws' && type !== 'web') {
      throw new Error('type must be `web` or `ws`');
    }
    const passes = type === 'ws' ? this.wsPasses : this.webPasses;
    let i = false;

    passes.forEach(function(v, idx) {
      if (v.name === passName) i = idx;
    });

    if (i === false) throw new Error('No such pass');

    passes.splice(i++, 0, callback);
  }

  createRightProxy(type) {
    return function processRequest (req, res ) {
      var passes = type === "ws" ? this.wsPasses : this.webPasses,
        args = [].slice.call(arguments),
        cntr = args.length - 1,
        head,
        cbl;

      /* optional args parse begin */
      if (typeof args[cntr] === "function") {
        cbl = args[cntr];

        cntr--;
      }

      var requestOptions = this.options;
      if (!(args[cntr] instanceof Buffer) && args[cntr] !== res) {
        //Copy global options
        requestOptions = extend({}, this.options);
        //Overwrite with request options
        extend(requestOptions, args[cntr]);

        cntr--;
      }

      if (args[cntr] instanceof Buffer) {
        head = args[cntr];
      }

      /* optional args parse end */

      ["target", "forward"].forEach((e) => {
        if (typeof requestOptions[e] === "string")
          requestOptions[e] = parse_url(requestOptions[e]);
      });

      if (!requestOptions.target && !requestOptions.forward) {
        return this.emit(
          "error",
          new Error("Must provide a proper URL as target"),
          req,
          res
        );
      }

      for (var i = 0; i < passes.length; i++) {
        /**
         * Call of passes functions
         * pass(req, res, options, head)
         *
         * In WebSockets case the `res` variable
         * refer to the connection socket
         * pass(req, socket, options, head)
         */
        if (passes[i](req, res, requestOptions, head, this, cbl)) {
          // passes can return a truthy value to halt the loop
          break;
        }
      }
    };
  };
}
