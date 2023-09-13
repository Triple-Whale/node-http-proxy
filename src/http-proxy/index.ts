import url from "url";
import { EventEmitter as EE3 } from "eventemitter3";
import http from "http";
import https from "https";
import webPasses from "./passes/web-incoming";
import wsPasses from "./passes/ws-incoming";
import { proxyOptions } from "../index";
import internal from "stream";
import { isWebsocket } from "./common";

type ProxyWeb = (args: {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  options?: proxyOptions;
}) => void;

type ProxyWs = (args: {
  req: http.IncomingMessage;
  socket: internal.Duplex;
  head: Buffer;
  options?: proxyOptions;
}) => void;

export class ProxyServer extends EE3 {
  web: ProxyWeb;
  ws: ProxyWs;
  proxyRequest: ProxyWeb;
  proxyWebsocketRequest: ProxyWs;
  options: proxyOptions;
  webPasses;
  wsPasses;
  _server: https.Server | http.Server;
  constructor(options: proxyOptions) {
    super();
    options = options || {};
    options.prependPath = options.prependPath === false ? false : true;

    this.web = this.proxyRequest = this.createRightProxy("web");
    this.ws = this.proxyWebsocketRequest = this.createRightProxy("ws");
    this.options = options;

    this.webPasses = Object.values(webPasses);
    this.wsPasses = Object.values(wsPasses);

    this.on("error", this.onError, this);
  }

  onError(err) {
    if (this.listeners("error").length === 1) {
      throw err;
    }
  }

  listen(port: number, hostname: string) {
    const self = this;
    const closure = function (req, res) {
      self.web({ req, res });
    };

    this._server = this.options.ssl
      ? https.createServer(this.options.ssl, closure)
      : http.createServer(closure);

    if (this.options.ws) {
      this._server.on("upgrade", function (req, socket, head) {
        // @ts-ignore
        self.ws({ req, socket, head });
      });
    }

    this._server.listen(port, hostname);
    return this;
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
    if (type !== "ws" && type !== "web") {
      throw new Error("type must be `web` or `ws`");
    }
    const passes = type === "ws" ? this.wsPasses : this.webPasses;
    let i = false;

    passes.forEach(function (v, idx) {
      if (v.name === passName) i = idx;
    });

    if (i === false) throw new Error("No such pass");

    passes.splice(i, 0, callback);
  }

  after(type, passName, callback) {
    if (type !== "ws" && type !== "web") {
      throw new Error("type must be `web` or `ws`");
    }
    const passes = type === "ws" ? this.wsPasses : this.webPasses;
    let i = false;

    passes.forEach(function (v, idx) {
      if (v.name === passName) i = idx;
    });

    if (i === false) throw new Error("No such pass");

    passes.splice(i++, 0, callback);
  }

  all(args: {
    req: http.IncomingMessage;
    res: http.ServerResponse;
    errorHandler?: Function;
    options?: proxyOptions;
  }) {
    const ws = isWebsocket(args.req);
    if (!ws) {
      this.web(args);
    } else {
      this.ws({
        req: args.req,
        socket: args.req.socket,
        head: Buffer.from(""),
        ...args,
        // @ts-ignore
        res: null,
      });
    }
  }

  createRightProxy(type: "ws" | "web") {
    return function processRequest(args: {
      req: http.IncomingMessage;
      res?: http.ServerResponse;
      socket?: internal.Duplex;
      head?: Buffer;
      errorHandler?: Function;
      options?: proxyOptions;
    }) {
      const passes = type === "ws" ? this.wsPasses : this.webPasses;
      const { req, res, options, head, errorHandler, socket } = args;
      const requestOptions = { ...this.options, ...options };
      ["target", "forward"].forEach((e) => {
        if (typeof requestOptions[e] === "string")
          requestOptions[e] = url.parse(requestOptions[e]);
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
        const passRes = passes[i](
          req,
          res || socket,
          requestOptions,
          head,
          this,
          errorHandler
        );
        if (passRes) {
          // passes can return a truthy value to halt the loop
          break;
        }
      }
    };
  }
}
