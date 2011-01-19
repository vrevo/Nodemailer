var netlib = require("net"),
    fslib = require("fs"),
    utillib = require("util"),
    EventEmitter = require('events').EventEmitter;

// expose constructor SMTPClient to the world
exports.SMTPClient = SMTPClient;


/**
 * new SMTPClient(host, port[, options])
 * - host (String): SMTP server hostname
 * - port (Number): SMTP server port
 * - options (Object): optional additional settings
 * 
 * Constructs a wrapper for a SMTP connection as an EventEmitter type object.
 * 
 * options can include following data:
 * 
 * - hostname (String): hostname of the sending server, needed for handshake
 *   default is "untitled.server"
 * - use_authorization (Boolean): is authorization needed, default is false
 * - user (String): the username if authorization is needed
 * - pass (String): the password if authorization is needed
 * 
 * Authorization is somewhat problematic with Node.JS v0.3.x since it doesn't
 * support setSecure which is needed to enter TLS state AFTER non-encrypted
 * SMTP handshake. Most servers doesn't accept plaintext passwords without TLS. 
 * 
 * Supported events:
 * 
 * - 'connect' if a connection is opened successfully 
 * - 'error' if an uncatched error occurs
 * - 'close' when the connection closes
 *     
 **/
function SMTPClient(host, port, options){
    
    // Needed to convert this constructor into EventEmitter
    EventEmitter.call(this);
    
    // Public properties
    // -----------------
    this.host = host;
    this.port = port || 25;
    this.options = options || {};
    this.hostname = this.options.hostname || "untitled.server";

    this.remote_pipelining = false; // Is pipelining enabled
    this.remote_starttls = false;   // Is TLS enabled, currently no effect
    this.remote_extended = true;    // Does the server support EHLO or HELO

    // Not so public properties
    // ------------------------
    this._connected = false;   // Indicates if an active connection is available
    this._connection = false;  // Holds connection info
    this._callbackQueue = [];  // Queues the responses FIFO (needed for pipelining)
    this._data_remainder = []; // Needed to group multi-line messages from server
    
    // check if host exists
    if(!this.host){
        var error = new Error("SMTP Host is not set");
        this.emit("error", error);
        return;
    }

}
// Needed to convert this constructor into EventEmitter
utillib.inherits(SMTPClient, EventEmitter);

///////////// PUBLIC METHODS /////////////

/**
 * SMTPClient#send(data, callback) -> undefined
 * - data (String): text to be sent to the SMTP server
 * - callback (Function): callback to be used, gets params error and message
 * 
 * Main method for the SMTPClient object. Sends a string to the server and
 * if callback is set returns the response. If callback is not set then
 * the endline chars \r\n are not appended automatically
 * 
 * NB! This function is Pipelining safe but you should check the support for
 * it if needed (#remote_pipelining).
 * 
 * Usage:
 * 
 *     smtpclient.send("EHLO hostname", function(error, message){
 *         if(error){
 *             console.log("Server responded with error "+error.message);
 *         }else{
 *             console.log("Server responded with "+message);
 *         }
 *     });
 * 
 *     smtpclient.send("From: andris@node.ee\r\nTo: andris@kreata.ee\r\nSubject: test\r\n");
 * 
 * If there is no connection to the SMTP server, one is created automatically
 **/
SMTPClient.prototype.send = function(data, callback){

    if(!this._connected){
        return this._createConnection(this.send.bind(this, data, callback));
    }

    if(callback){
        this._sendCommand(data, callback);
    }else{
        this._sendData(data);
    }

}

/**
 * SMTPClient#close() -> undefined
 * 
 * Closes the current connection to the server. For some reason needed after
 * the e-mail is sent (with QUIT) but might be server specific.
 **/
SMTPClient.prototype.close = function(){
    this._connected && this._connection && this._connection.end();
    this._connected = false;
};

///////////// PRIVATE METHODS /////////////

/**
 * SMTPClient#_sendCommand(data, callback) -> undefined
 * - data (String): string value to be sent to the SMTP server
 * - callback (Function): function to be run after the server has responded
 * 
 * Sends a string to the server, appends \r\n to the end so this is not
 * meant to send data (mail body) but comands.
 **/
SMTPClient.prototype._sendCommand = function(data, callback){
    this._callbackQueue.push({callback: callback});
    this._connection.write(data+"\r\n");
    
    //DEBUG:
    //console.log("WRITE:\n"+JSON.stringify(data+"\r\n"));
}

/**
 * SMTPClient#_sendData(data) -> undefined
 * - data (String): Text to be sent to the server
 * 
 * Sends a string to the server. This is meant to send body data and such.
 **/
SMTPClient.prototype._sendData = function(data){
    this._connection.write(data);
    
    //DEBUG:
    //console.log("WRITE:\n"+JSON.stringify(data));
}

/**
 * SMTPClient#_loginHandler(callback) -> undefined
 * - callback (Function): function to be run after successful login
 * 
 * If authentication is needed, performs AUTH PLAIN and runs the
 * callback function after success or emits error on fail.
 * This method is called by #_handshake after successful connection
 * 
 * Callback is set by the caller of #_createConnection which forwards it
 * to #_handshake whic in turn forwards it to #_loginHandler
 **/
SMTPClient.prototype._loginHandler = function(callback){
    //FIXME: Plaintext AUTH generally needs TSL support, problematic with Node.JS v0.3
    
    if(!this.options.use_authentication){
        callback();
    }else{
        this.send("AUTH PLAIN "+new Buffer(
          this.options.user+"\u0000"+
          this.options.user+"\u0000"+
          this.options.pass).toString("base64"), (function(error, message){
            if(error){
                this.emit("error", error);
                this._connected = false;
                this.close();
                return;
            }
            // login success
            callback();
        }).bind(this));
    }
}

/**
 * SMTPClient#_currentListener -> Function
 * 
 * Points to the function that is currently needed to handle responses
 * from the SMTP server.
 **/
SMTPClient.prototype._currentListener = function(data){}

/**
 * SMTPClient#_normalListener(data) -> undefined
 * - data(String): String received from the server
 * 
 * The default listener for incoming server messages. Checks if there's
 * no errors and runs a callback function from #_callbackQueue.
 * If the first char of the response is higher than 3 then the response
 * is considered erroneus.
 **/
SMTPClient.prototype._normalListener = function(data){
    var action = this._callbackQueue.shift();
    if(action && action.callback){
        if(parseInt(data.trim().charAt(0),10)>3){
            action.callback(new Error(data), null);
        }else{
            action.callback(null, data);
        }
    }else{
        if(parseInt(data.trim().charAt(0),10)>3){
            this.emit("error", new Error(data));
            this._connected = false;
            this.close();
        }else{
            // what the hell just happened? this should never occur
        }
    }
}

/**
 * SMTPClient#_handshakeListener(data) -> undefined
 * - data(String): String received from the server
 * 
 * Server data listener for the handshake - waits for the 220 response
 * from the server (connection established). Changes the #_currentListener
 * to #_normalListener on success
 **/
SMTPClient.prototype._handshakeListener = function(data){
    if(!this._connected){
        if(data.trim().substr(0,3)=="220"){
            this._connected = true; // connection established
        }else{
            var error = new Error("Server responded with "+data);
            this.emit("error", error);
            this._connected = false;
            this.close();
            return;
        }
    }else{
        this._currentListener = this._normalListener;
        this._currentListener(data);
    }
}

/**
 * SMTPClient#_handshake(callback) -> undefined
 * - callback (Function): will be forwarded to login after successful connection
 * 
 * Will be run after a TCP connection to the server is established. Makes
 * a EHLO command (fallbacks to HELO on failure) and forwards the callback to
 * login function on success.
 **/
SMTPClient.prototype._handshake = function(callback){
    this.emit("connect");
    this._sendCommand("EHLO "+this.hostname, (function(error, data){
        if(error){

            // fallback to HELO
            this._sendCommand("HELO "+this.hostname, (function(error, data){
                if(error){
                    this.emit("error", error);
                    this._connected = false;
                    this.close();
                    return;
                }
                this.remote_extended = false;
                this._loginHandler(callback);    
            }).bind(this));
            
        }
        
        // check for pipelining support
        if(data.match(/PIPELINING/i)){
            this.remote_pipelining = true;
        }
        
        // check for TLS support
        if(data.match(/STARTTLS/i)){
            this.remote_starttls = true;
        }

        // check login after successful handshake
        this._loginHandler(callback);
    }).bind(this));
}

/**
 * SMTPClient#_onData(data) -> function
 * - data (Buffer): binary data from the server
 * 
 * Receives binary data from the server, converts it to string and forwards
 * to a registered listener. Concatenates multiline messages etc.
 **/
SMTPClient.prototype._onData = function(data){
    
    //DEBUG:
    //console.log("RECEIVE:\n"+JSON.stringify(data.toString("utf-8")));
    
    var lines = data.toString("utf-8").split("\r\n"), i, length, parts;
    for(i=0, length=lines.length; i<length; i++){
        if(!lines[i].trim())
            continue;
        
        this._data_remainder.push(lines[i]);
        
        parts = lines[i].match(/^\d+(.)/);
        if(parts && parts[1]==" "){
            this._currentListener(this._data_remainder.join("\r\n"));
            this._data_remainder = [];
        }
    }
}

/**
 * SMTPClient#_createConnection(callback) -> function
 * - callback (Function): function to be run after successful connection,
 *   smtp handshake and login
 * 
 * Creates a TCP connection to the SMTP server and sets up needed listeners.
 **/
SMTPClient.prototype._createConnection = function(callback){
    
    this._connection = netlib.createConnection(this.port, this.host);
    
    this._connection.on("end", (function(){
        this._connected = false;
    }).bind(this));
    
    this._connection.on("close", (function(){
        this._connected = false;
        this.emit("close");
    }).bind(this));
    
    this._connection.on("timeout", (function(){
        this.close();
    }).bind(this));
    
    this._connection.on("error", (function(error){
        this.emit("error", error);
        this.close();
    }).bind(this));
    
    this._connection.on("connect", this._handshake.bind(this, callback));
    this._connection.on("data", this._onData.bind(this));
    this._currentListener = this._handshakeListener;
}