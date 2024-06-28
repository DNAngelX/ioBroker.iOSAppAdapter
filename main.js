'use strict';

const utils = require('@iobroker/adapter-core');
const express = require('express');
const bodyParser = require('body-parser');

class Iobapp extends utils.Adapter {
    constructor(options) {
        super({
            ...options,
            name: 'iobapp',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('unload', this.onUnload.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));

        this.app = express();
        this.server = null;
    }

    async onReady() {
        this.log.debug('Adapter ready: Initializing express app.');
        this.app.use(bodyParser.json({
            strict: true,
            verify: (req, res, buf) => {
                try {
                    JSON.parse(buf);
                } catch (e) {
                    this.log.error('Invalid JSON received:', buf.toString());
                    throw new Error('Invalid JSON');
                }
            }
        }));

        this.app.get('/onlineState', this.handleOnlineState.bind(this));
        this.app.get('/persons', this.handleGetPersons.bind(this));
        this.app.get('/persons/:person/devices', this.handleGetDevices.bind(this));
        this.app.post('/persons', this.handlePostPersons.bind(this));
        this.app.post('/persons/:person/devices', this.handlePostDevices.bind(this));
        this.app.post('/set/:path', this.handleSet.bind(this));
        this.app.post('/setPresence', this.handleSetPresence.bind(this));
        this.app.get('/getZones', this.handleGetZones.bind(this));

        const port = this.config.port || 8082;
        this.server = this.app.listen(port, () => {
            this.log.info(`Server listening on port ${port}`);
        });

        this.subscribeStates('*');
    }

    onUnload(callback) {
        try {
            this.log.debug('Adapter is unloading.');
            if (this.server) {
                this.server.close(() => {
                    this.log.debug('Server closed.');
                    callback();
                });
            } else {
                callback();
            }
        } catch (e) {
            callback();
        }
    }

    onStateChange(id, state) {
        if (state) {
            this.log.info(`State ${id} changed: ${state.val} (ack = ${state.ack})`);
        } else {
            this.log.info(`State ${id} deleted`);
        }
    }

    async onMessage(obj) {
        if (typeof obj === 'object' && obj.message) {
            if (obj.command === 'saveSettings') {
                this.log.debug('Received request to save settings:', obj.message);
                this.config.username = obj.message.username;
                this.config.password = obj.message.password;
                this.config.port = obj.message.port;
                this.saveConfig(() => {
                    this.sendTo(obj.from, obj.command, { result: 'Settings saved' }, obj.callback);
                    this.log.debug('Settings saved successfully.');
                });
            }
        }
    }

    async handleOnlineState(req, res) {
        this.log.debug('Received request for onlineState.');

        try {
            const systemConfig = await this.getForeignObjectAsync('system.config');
            const latitude = systemConfig && systemConfig.common && systemConfig.common.latitude;
            const longitude = systemConfig && systemConfig.common && systemConfig.common.longitude;

            res.send({ 
                online: true,
                location: latitude + "," + longitude
            });
        } catch (err) {
            this.log.error('Error getting system config:', err);
            res.status(500).send({ 
                online: true,
                location: {
                    latitude: null,
                    longitude: null
                },
                error: 'Could not retrieve location information'
            });
        }
    }

    async handleGetPersons(req, res) {
        this.log.debug('Received request to get persons.');
        try {
            const objects = await this.getForeignObjectsAsync(`${this.namespace}.person.*`, 'state');
            const persons = new Set();

            for (const id in objects) {
                if (objects.hasOwnProperty(id)) {
                    const personMatch = id.match(/^iobapp\.\d+\.person\.([^\.]+)/);
                    if (personMatch) {
                        persons.add(personMatch[1]);
                    }
                }
            }

            const personsArray = Array.from(persons).map(person => ({ person }));
            this.log.debug('Sending persons:', personsArray);
            res.send(personsArray);
        } catch (err) {
            this.log.error('Error getting persons:', err);
            res.status(500).send(err);
        }
    }

    async handleGetDevices(req, res) {
        const person = req.params.person;
        this.log.debug(`Received request to get devices for person: ${person}`);
        try {
            const objects = await this.getForeignObjectsAsync(`${this.namespace}.person.${person}.*`, 'state');
            const devices = new Set();

            for (const id in objects) {
                if (objects.hasOwnProperty(id)) {
                    const deviceMatch = id.match(/^iobapp\.\d+\.person\.[^\.]+\.([^\.]+)/);
                    if (deviceMatch) {
                        devices.add(deviceMatch[1]);
                    }
                }
            }

            const devicesArray = Array.from(devices).map(device => ({ device }));
            this.log.debug('Sending devices:', devicesArray);
            res.send(devicesArray);
        } catch (err) {
            this.log.error(`Error getting devices for person ${person}:`, err);
            res.status(500).send(err);
        }
    }

    async handlePostPersons(req, res) {
        const person = req.body.person;
        this.log.debug(`Received request to create person: ${person}`);
        try {
            await this.setObjectNotExistsAsync(`${this.namespace}.person.${person}`, {
                type: 'channel',
                common: { name: person },
                native: {},
            });
            this.log.debug(`Person ${person} created.`);
            res.send({ success: true });
        } catch (err) {
            this.log.error(`Error creating person ${person}:`, err);
            res.status(500).send(err);
        }
    }

    async handlePostDevices(req, res) {
        const person = req.params.person;
        const device = req.body.device;
        const sensors = req.body.sensors; // Expecting sensors as an array of objects
        this.log.debug(`Received request to create device: ${device} for person: ${person} with sensors: ${JSON.stringify(sensors)}`);
        const basePath = `${this.namespace}.person.${person}.${device}`;

        try {
            await this.setObjectNotExistsAsync(basePath, {
                type: 'channel',
                common: { name: device },
                native: {},
            });

            // Create sensor data objects dynamically
            for (const sensor of sensors) {
                const sensorPath = `${basePath}.${sensor.name}`;
                await this.setObjectNotExistsAsync(sensorPath, {
                    type: 'state',
                    common: { 
                        name: sensor.name, 
                        type: sensor.type, 
                        role: sensor.role || 'value', 
                        unit: sensor.unit || '', 
                        states: sensor.states || undefined 
                    },
                    native: {},
                });
                this.log.debug(`Sensor ${sensor.name} created for device ${device}.`);
            }

            this.log.debug(`Device ${device} created for person ${person}.`);
            res.send({ success: true });
        } catch (err) {
            this.log.error(`Error creating device ${device} for person ${person}:`, err);
            res.status(500).send(err);
        }
    }

    async handleSet(req, res) {
        const path = req.params.path;
        const value = req.body.value;
        this.log.debug(`Received request to set value for path: ${path} to ${value}`);
        try {
            await this.setForeignStateAsync(`${this.namespace}.${path}`, value);
            this.log.debug(`Value for path ${path} set to ${value}`);
            res.send({ success: true });
        } catch (err) {
            this.log.error(`Error setting value for path ${path}:`, err);
            res.status(500).send(err);
        }
    }

	async handleSetPresence(req, res) {
        const { locationName, person, presence, distance } = req.body;
        this.log.debug(`Received request to set presence for zone: ${locationName}, person: ${person} with presence: ${presence} and distance: ${distance}`);
        
        if (presence !== undefined) {
            const pathPresence = `${this.namespace}.zones.${locationName}.${person}`;
            try {
                await this.setObjectNotExistsAsync(pathPresence, {
                    type: 'state',
                    common: {
                        name: `${person} presence in ${locationName}`,
                        type: 'boolean',
                        role: 'indicator',
                        read: true,
                        write: true,
                    },
                    native: {},
                });

                await this.setStateAsync(pathPresence, presence, true);
                this.log.debug(`Presence for ${person} in ${locationName} set to ${presence}`);
            } catch (err) {
                this.log.error(`Error setting presence for ${person} in ${locationName}:`, err);
                res.status(500).send(err);
                return;
            }
        }

        if (distance !== undefined) {
            const pathDistance = `${this.namespace}.zones.${locationName}.${person}_distance`;
            try {
                await this.setObjectNotExistsAsync(pathDistance, {
                    type: 'state',
                    common: {
                        name: `${person} distance in ${locationName}`,
                        type: 'number',
                        role: 'value',
                        read: true,
                        write: true,
                    },
                    native: {},
                });

                await this.setStateAsync(pathDistance, distance, true);
                this.log.debug(`Distance for ${person} in ${locationName} set to ${distance}`);
            } catch (err) {
                this.log.error(`Error setting distance for ${person} in ${locationName}:`, err);
                res.status(500).send(err);
                return;
            }
        }

        res.send({ success: true });
    }

    async handleGetZones(req, res) {
        this.log.debug('Received request to get zones.');
        try {
            const objects = await this.getForeignObjectsAsync(`${this.namespace}.zones.*`, 'state');
            const zones = new Set();

            for (const id in objects) {
                if (objects.hasOwnProperty(id)) {
                    const zoneMatch = id.match(/^iobapp\.\d+\.zones\.([^\.]+)/);
                    if (zoneMatch) {
                        zones.add(zoneMatch[1]);
                    }
                }
            }

            const zonesArray = Array.from(zones).map(zone => ({ zone }));
            this.log.debug('Sending zones:', zonesArray);
            res.send(zonesArray);
        } catch (err) {
            this.log.error('Error getting zones:', err);
            res.status(500).send(err);
        }
    }
}

if (module.parent) {
    module.exports = (options) => new Iobapp(options);
} else {
    new Iobapp();
}
