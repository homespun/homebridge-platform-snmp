# homebridge-platform-snmp
An [SNMP](https://en.wikipedia.org/wiki/Simple_Network_Management_Protocol) platform plugin for
[Homebridge](https://github.com/nfarina/homebridge).

# Installation
Run these commands:

    % sudo npm install -g homebridge
    % sudo npm install -g homebridge-platform-snmp

On Linux, you might see this output for the second command:

    npm ERR! pcap2@3.0.4 install: node-gyp rebuild
    npm ERR! Exit status 1
    npm ERR!

If so, please try

    % apt-get install libpcap-dev

and try

    % sudo npm install -gring-video-doorbell homebridge-platform-snmp

again!

NB: If you install homebridge like this:

    sudo npm install -g --unsafe-perm homebridge

Then all subsequent installations must be like this:

    sudo npm install -g --unsafe-perm homebridge-platform-snmp

# Configuration
If you're already running `homebridge` on your system,
then you already have a `~/.homebridge/config.json` file and no configuration is needed!

This is a "dynamic" platform plugin,
so it will automatically look for SNMP agents on the local network that respond to SNMPv2/public.
Future versions may allow you to specify addressing and authentication information for individual agents.

If this is your first time with `homebridge`,
this will suffice:

    { "bridge":
      { "name": "Homebridge"
      , "username": "CC:22:3D:E3:CE:30"
      , "port": 51826
      , "pin": "031-45-154"
      }
    , "description": ""
    , "accessories":
      [
      ]
    , "platforms":
      [
        { "platform" : "homebridge-platform-snmp"
        , "name"     : "SNMP"
        }
      ]
    }

# Supported Agents
At present,
only the excellent [ServersCheck](https://serverscheck.com/) environmental sensors are supported.

