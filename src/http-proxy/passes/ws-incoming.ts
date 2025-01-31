import http, { IncomingMessage } from "http";
import https from "https";
import {
  getPort,
  hasEncryptedConnection,
  isSSL,
  isWebsocket,
  setupOutgoing,
  setupSocket,
} from "../common";
import { Socket } from "net";

/*!
 * Array of passes.
 *
 * A `pass` is just a function that is executed on `req, socket, options`
 * so that you can easily add new checks while still keeping the base
 * flexible.
 */

/*
 * Websockets Passes
 *
 */

export default {
  /**
   * WebSocket requests must have the `GET` method and
   * the `upgrade:websocket` header
   *
   * @param {ClientRequest} Req Request object
   * @param {Socket} Websocket
   *
   * @api private
   */

  checkMethodAndHeader: function checkMethodAndHeader(req, socket) {
    if (!isWebsocket(req)) {
      socket.destroy();
      return true;
    }
  },

  /**
   * Sets `x-forwarded-*` headers if specified in config.
   *
   * @param {ClientRequest} Req Request object
   * @param {Socket} Websocket
   * @param {Object} Options Config object passed to the proxy
   *
   * @api private
   */

  XHeaders: function xHeaders(req: IncomingMessage, _socket, options) {
    if (!options.xfwd) return;

    const values = {
      for: req.socket.remoteAddress,
      port: getPort(req),
      proto: hasEncryptedConnection(req) ? "wss" : "ws",
    };

    ["for", "port", "proto"].forEach((header) => {
      req.headers["x-forwarded-" + header] =
        (req.headers["x-forwarded-" + header] || "") +
        (req.headers["x-forwarded-" + header] ? "," : "") +
        values[header];
    });
  },

  /**
   * Does the actual proxying. Make the request and upgrade it
   * send the Switching Protocols request and pipe the sockets.
   *
   * @param {ClientRequest} Req Request object
   * @param {Socket} Websocket
   * @param {Object} Options Config object passed to the proxy
   *
   * @api private
   */
  stream: function stream(
    req,
    socket: Socket,
    options,
    head,
    server,
    errorHandler
  ) {
    function createHttpHeader(line, headers) {
      return (
        Object.keys(headers)
          .reduce(
            (header, key) => {
              const value = headers[key];
              if (!Array.isArray(value)) {
                header.push(key + ": " + value);
                return header;
              }
              for (let i = 0; i < value.length; i++) {
                header.push(key + ": " + value[i]);
              }
              return header;
            },
            [line]
          )
          .join("\r\n") + "\r\n\r\n"
      );
    }

    setupSocket(socket);

    if (head && head.length) socket.unshift(head);

    const requestOptions = {
      ...options.ssl,
      ...options.requestOptions,
    };

    var upstreamReq = (
      isSSL.test(options.target.protocol) ? https : http
    ).request(setupOutgoing(requestOptions, options, req));

    // Enable developers to modify the upstreamReq before headers are sent
    server.emit("proxyReqWs", upstreamReq, req, socket, options, head);

    // Error Handler
    upstreamReq.on("error", onOutgoingError);
    upstreamReq.on("response", (upstreamRes) => {
      // if upgrade event isn't going to happen, close the socket
      // @ts-ignore
      if (!upstreamRes.upgrade) {
        socket.write(
          createHttpHeader(
            "HTTP/" +
              upstreamRes.httpVersion +
              " " +
              upstreamRes.statusCode +
              " " +
              upstreamRes.statusMessage,
            upstreamRes.headers
          )
        );
        upstreamRes.pipe(socket);
      }
    });

    upstreamReq.on("upgrade", (upstreamRes, upstreamSocket, proxyHead) => {
      upstreamSocket.on("error", onOutgoingError);

      // Allow us to listen when the websocket has completed
      upstreamSocket.on("end", () => {
        server.emit("close", upstreamRes, upstreamSocket, proxyHead);
      });

      // The pipe below will end upstreamSocket if socket closes cleanly, but not
      // if it errors (eg, vanishes from the net and starts returning
      // EHOSTUNREACH). We need to do that explicitly.
      socket.on("error", () => {
        upstreamSocket.end();
      });

      setupSocket(upstreamSocket);

      if (proxyHead && proxyHead.length) upstreamSocket.unshift(proxyHead);

      //
      // Remark: Handle writing the headers to the socket when switching protocols
      // Also handles when a header is an array
      //
      socket.write(
        createHttpHeader(
          "HTTP/1.1 101 Switching Protocols",
          upstreamRes.headers
        )
      );

      upstreamSocket.pipe(socket).pipe(upstreamSocket);

      server.emit("open", upstreamSocket);
      server.emit("proxySocket", upstreamSocket); //DEPRECATED.
    });

    return upstreamReq.end(); // XXX: CHECK IF THIS IS THIS CORRECT

    function onOutgoingError(err) {
      if (errorHandler) {
        errorHandler(err, req, socket);
      } else {
        server.emit("error", err, req, socket);
      }
      socket.end();
    }
  },
};
