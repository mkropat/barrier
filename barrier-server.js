// barrier-server.js

// Maintainer: Michael Kropat <mail@michael.kropat.name>

// barrier, n.
//   Blocks the caller until all group members have called it; the call returns
//   at any process only after all group members have entered the call.
//     — from the Open MPI documentation for MPI_Barrier [1]

// barrier-server.js synchronizes script excecution across multiple hosts in
// such a way to guarantee that all scripts reach a certain point before any
// particular script is allowed to continue. While traditional barrier
// synchronization is used in high-performance computing, this implementation
// is intended for non-performance-critical uses. The key design goals are:

// * Ability to run from simple Bash scripts.

// * Synchronize among different hosts over the network or even the internet.

// Client Protocol
// ---------------

// An implementation of the client is provided along with this implementation
// in the Bash script named “barrier”. The implementation of the client is
// trivial: upon reaching the barrier, the client makes an HTTP POST request to
// the server to check-in. The client’s id is passed in
// “application/x-www-form-urlencoded” format. The server then holds the HTTP
// request open until all clients have checked in (the list of clients is
// specified in the server configuration).  When the client receives an HTTP
// 200 response, it knows that it can safely continue.

// Note that requests to different URLs represent different groups, each having
// their own independent list of clients as well as checked-in (that is,
// connected) status. In this way, one server can provide barrier
// synchronization for multiple, logically-independent operations.

// Running
// -------

// The server is implemented as a node.js application. First, install
// pre-requisites:

// Debian / Ubuntu:
// apt-get install nodejs

// CentOS / Fedora / RedHat:
// wget http://nodejs.org/dist/node-v0.4.12.tar.gz
// ./configure && make && make install # sucks

// Second, create the config file, barrier-server.conf, in the same directory
// as barrier-server.js. See the Configuration section below for details.

// Finally, start the server with: node barrier-server.js

var fs = require('fs'),
    http = require('http'),
    querystring = require('querystring');

// Configuration
// -------------

// The config file specifies the list of all clients required to check-in at a
// given url, as well as server parameters such as the listen port. The format
// is strict JSON. See barrier-server.sample.conf for a sample configuration.

var config = {
    expected: { '/': [] },
    hostname: null,
    keepAliveIntervalMs: 60 * 1000,
    port: 1337,
};
var configPath = './barrier-server.conf';
try {
    var userConfig = JSON.parse(fs.readFileSync(configPath, encoding='utf-8'));
    Object.keys(userConfig).forEach(function(k) { config[k] = userConfig[k]; });
} catch (ex) {
    console.warn('Warning: unable to read config file at: "%s"', configPath);
}

// Implementation
// --------------

var checkinStore = {};
var server = http.createServer(function (req, res) {
    var reqBody = '';
    req.on('data', function(chunk) { reqBody += chunk.toString(); });
    req.on('end', function() {
        try {
            if (req.method !== 'POST') throw new HttpError(405);

            var expectedIds = config.expected[req.url];
            if (expectedIds === undefined) throw new HttpError(404);

            var postData = querystring.parse(reqBody);
            var id = postData['id'];
            if (expectedIds.indexOf(id) === -1) {
                throw new HttpError(400, 'Unrecognized id: "' + id + '"\r\n');
            }

            checkinStore[req.url] = checkinStore[req.url] || {};
            var checkins = checkinStore[req.url];
            if (checkins[id] !== undefined) {
                throw new HttpError(400, 'Duplicate id: "' + id + '"\r\n');
            }

            res.writeHead(200, {
                'Content-Type': 'text/plain',
                'Transfer-Encoding': 'chunked', // for sending keep alives
            });
            checkins[id] = res;

            // We will not call res.end() until all the clients have checked
            // in, and in so doing, node.js will keep the request open in the
            // meanwhile.

            var allCheckedIn = !expectedIds.some(
                function(id) { return checkins[id] === undefined; });
            if (allCheckedIn) {
                // Normally, clearing out the client list would be a
                // synchronization problem, since a client could call barrier
                // again before all the other clients have left the barrier.
                // Because we are running on node.js, however, which handles
                // all requests in a single thread, the solution becomes
                // trivial.
                Object.keys(checkins).forEach(
                    function(id) { checkins[id].end('GO\r\n'); });
                checkins = checkinStore[req.url] = {};
            }
        } catch (ex) {
            if (!(ex instanceof HttpError)) throw ex;
            res.statusCode = ex.statusCode;
            res.end(ex.message);
        }
    });
});
server.listen(config.port, config.hostname);
console.log('Listening on %s:%d',
    config.hostname === null ? '0.0.0.0' : config.hostname,
    config.port)

// Periodically send data to all clients in an attempt to keep the connection
// open indefinitely. There is no guarantee that the connection will not
// terminate abruptly, so it is up to the client to religiously check the exit
// code and handle errors appropriately.
setInterval(function() {
    Object.keys(checkinStore).forEach(function(url) {
        Object.keys(checkinStore[url]).forEach(function(id) {
            checkinStore[url][id].write('HOLD\r\n');
        });
    });
}, config.keepaliveIntervalMs);

function HttpError(statusCode, message) {
    this.statusCode = statusCode || 400;
    this.message = message;
}

// References:

// [1] http://www.open-mpi.org/doc/v1.4/man3/MPI_Barrier.3.php
