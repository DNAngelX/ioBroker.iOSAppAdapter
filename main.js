'use strict';

const utils = require('@iobroker/adapter-core');
const express = require('express');
const bodyParser = require('body-parser');
const WebSocket = require('ws');


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
        this.wsServer = null; // WebSocket server
        this.messageQueue = [];
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
        this.app.get('/tagsTrigger', this.handleTagsTrigger.bind(this));
        this.app.post('/tagsTrigger', this.handleCreateTag.bind(this));

        const restPort = this.config.restPort || 9191;
        const wsPort = this.config.wsPort || 9192;
        
        this.server = this.app.listen(restPort, () => {
            this.log.info(`REST server listening on port ${restPort}`);
        });

        this.initializeWebSocket(wsPort);

        this.subscribeStates('*');
    }

    onUnload(callback) {
        try {
            this.log.debug('Adapter is unloading.');
            if (this.server) {
                this.server.close(() => {
                    this.log.debug('Server closed.');
                });
            }
            if (this.wsServer) {
                this.wsServer.close(() => {
                    this.log.debug('WebSocket server closed.');
                });
            }
            callback();
        } catch (e) {
            callback();
        }
    }

    async onStateChange(id, state) {
        if (state) {
            this.log.info(`State ${id} changed: ${state.val} (ack = ${state.ack})`);
            if (id.endsWith('.send') && state.val === true) {
                await this.generatePayload(id);
                await this.setStateAsync(id, false, true);
            } else if (id.endsWith('.payload') && state.val !== '') {
                await this.handleAPNMessage(id);
            }
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
                this.config.restPort = obj.message.restPort;
                this.config.wsPort = obj.message.wsPort;
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

            // Create messages folder
            await this.createAPNObjects(person, device);

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

    async handleTagsTrigger(req, res) {
        const tagId = req.query.tagId;
        this.log.debug(`Received tagsTrigger for tag ID: ${tagId}`);
        const tagPath = `${this.namespace}.tags.${tagId}`;

        try {
            const tagObj = await this.getForeignObjectAsync(tagPath);
            if (tagObj) {
                this.log.debug(`Tag ${tagId} found in ioBroker`);
                await this.setStateAsync(tagPath, true, true);
                setTimeout(async () => {
                    await this.setStateAsync(tagPath, false, true);
                    this.log.debug(`Tag ${tagId} set to false`);
                }, 1000); // 1 Sekunde Verzögerung, um den Zustand zurückzusetzen
                res.send({ success: true });
            } else {
                this.log.debug(`Tag ${tagId} not found in ioBroker`);
                res.send({ success: false, message: 'missing tag' });
            }
        } catch (err) {
            this.log.error(`Error handling tagsTrigger for tag ID ${tagId}:`, err);
            res.status(500).send(err);
        }
    }

    async handleCreateTag(req, res) {
        const { tagId, name } = req.body;
        this.log.debug(`Received request to create tag with ID: ${tagId} and name: ${name}`);
        const tagPath = `${this.namespace}.tags.${tagId}`;

        try {
            await this.setObjectNotExistsAsync(tagPath, {
                type: 'state',
                common: {
                    name: name,
                    type: 'boolean',
                    role: 'indicator',
                    read: true,
                    write: true,
                },
                native: {},
            });

            this.log.debug(`Tag ${tagId} created with name ${name}`);
            res.send({ success: true });
        } catch (err) {
            this.log.error(`Error creating tag ${tagId}:`, err);
            res.status(500).send(err);
        }
    }

    initializeWebSocket(wsPort) {
        this.wsServer = new WebSocket.Server({ port: wsPort });

        this.wsServer.on('connection', (socket) => {
            this.log.info('WebSocket connection established.');

            socket.on('message', (message) => {
                this.log.info(`Received message: ${message}`);
            });

            socket.on('close', () => {
                this.log.info('WebSocket connection closed.');
            });

            this.sendQueuedMessages(socket);
        });

        this.wsServer.on('error', (error) => {
            this.log.error(`WebSocket error: ${error.message}`);
        });

        this.log.info(`WebSocket server listening on port ${wsPort}`);
    }

    async generatePayload(id) {
        const [namespace, person, device, ...rest] = id.split('.').slice(2);
        let basePath;
    
        if (device === 'messages') {
            basePath = `${this.namespace}.person.${person}.messages`;
        } else {
            basePath = `${this.namespace}.person.${person}.${device}.messages`;
        }
    
        try {
            const titleState = await this.getStateAsync(`${basePath}.title`);
            const subtitleState = await this.getStateAsync(`${basePath}.subtitle`);
            const bodyState = await this.getStateAsync(`${basePath}.body`);
            const bodyHtmlState = await this.getStateAsync(`${basePath}.body-html`);
            const soundState = await this.getStateAsync(`${basePath}.sound`);
            const mediaUrlState = await this.getStateAsync(`${basePath}.media-url`);
            const imageUrlState = await this.getStateAsync(`${basePath}.image-url`);
            const videoUrlState = await this.getStateAsync(`${basePath}.video-url`);
    
            const title = titleState ? titleState.val : '';
            const subtitle = subtitleState ? subtitleState.val : '';
            const body = bodyState ? bodyState.val : '';
            const bodyHtml = bodyHtmlState ? bodyHtmlState.val : '';
            const sound = soundState ? soundState.val : '';
            const mediaUrl = mediaUrlState ? mediaUrlState.val : '';
            const imageUrl = imageUrlState ? imageUrlState.val : '';
            const videoUrl = videoUrlState ? videoUrlState.val : '';
    
            const notification = {
                aps: {
                    alert: {
                        title: title || undefined,
                        subtitle: subtitle || undefined,
                        body: body || undefined,
                    },
                    sound: sound || undefined,
                },
                'body-html': bodyHtml || undefined,
                'media-url': mediaUrl || undefined,
                'image-url': imageUrl || undefined,
                'video-url': videoUrl || undefined
            };
    
            // Remove undefined properties
            Object.keys(notification).forEach(key => notification[key] === undefined && delete notification[key]);
            Object.keys(notification.aps).forEach(key => notification.aps[key] === undefined && delete notification.aps[key]);
            if (Object.keys(notification.aps.alert).length === 0) delete notification.aps.alert;
    
            const payload = JSON.stringify(notification);
            await this.setStateAsync(`${basePath}.payload`, payload, true);
            this.log.debug(`Payload generated for ${person === 'messages' ? 'general' : `${person}'s ${device}`}: ${payload}`);
        } catch (err) {
            this.log.error(`Error generating payload for ${person === 'messages' ? 'general' : `${person}'s ${device}`}: ${err.message}`);
        }
    }
    async handleAPNMessage(id) {
        const [namespace, person, device, ...rest] = id.split('.').slice(2);
        let basePath, tokenStates;
    
        if (device === 'messages') {
            basePath = `${this.namespace}.person.${person}.messages`;
            tokenStates = await this.getStatesAsync(`${this.namespace}.person.${person}.*.device_token`);
        } else {
            basePath = `${this.namespace}.person.${person}.${device}.messages`;
            tokenStates = {
                [`${this.namespace}.person.${person}.${device}.device_token`]: await this.getStateAsync(`${this.namespace}.person.${person}.${device}.device_token`)
            };
        }
    
        try {
            const payloadState = await this.getStateAsync(`${basePath}.payload`);
            const payload = payloadState ? payloadState.val : null;
    
            if (payload) {
                for (const [tokenId, tokenObj] of Object.entries(tokenStates)) {
                    const token = tokenObj ? tokenObj.val : null;
                    if (token) {
                        const message = { type: 'notification', token, payload };
                        if (this.wsServer && this.wsServer.clients && this.wsServer.clients.size > 0) {
                            this.sendMessageToClients(message);
                        } else {
                            this.messageQueue.push(message);
                            this.log.warn(`WebSocket not connected, queuing message for ${tokenId}`);
                        }
                    } else {
                        this.log.warn(`Ignoring device with missing token for ${tokenId}`);
                    }
                }
                await this.setStateAsync(`${basePath}.payload`, '', true);
            } else {
                this.log.warn(`Cannot send APN message, missing payload for ${basePath}`);
            }
        } catch (err) {
            this.log.error(`Error handling APN message for ${person === 'messages' ? 'general' : `${person}'s ${device}`}: ${err.message}`);
        }
    }
    
            
        
    

    sendMessageToClients(message) {
        this.wsServer.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(message));
                this.log.info(`Message sent to client: ${JSON.stringify(message)}`);
            }
        });
    }

    sendQueuedMessages(socket) {
        while (this.messageQueue.length > 0) {
            const message = this.messageQueue.shift();
            if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify(message));
                this.log.info(`Queued message sent to client: ${JSON.stringify(message)}`);
            } else {
                this.messageQueue.unshift(message);
                break;
            }
        }
    }
    
    async createAPNObjects(person, device) {
        const basePaths = [
            `${this.namespace}.person.${person}.${device}.messages`,
            `${this.namespace}.person.${person}.messages`        ];
    
        const commonStates = [
            { id: 'send', name: 'Send', type: 'boolean', role: 'button', read: false, write: true },
            { id: 'payload', name: 'Payload', type: 'string', role: 'text', read: true, write: true },
            { id: 'title', name: 'Nachrichtentitel', type: 'string', role: 'text', read: true, write: true },
            { id: 'subtitle', name: 'Nachrichtensubtitle', type: 'string', role: 'text', read: true, write: true },
            { id: 'body', name: 'Nachrichtentext', type: 'string', role: 'text', read: true, write: true },
            { id: 'body-html', name: 'Nachrichtentext HTML', type: 'string', role: 'text', read: true, write: true },
            { id: 'sound', name: 'Sound', type: 'string', role: 'text', read: true, write: true, states: { '': 'Kein', 'default': 'Default' } },
            { id: 'media-url', name: 'Media URL', type: 'string', role: 'text', read: true, write: true },
            { id: 'image-url', name: 'Image URL', type: 'string', role: 'text', read: true, write: true },
            { id: 'video-url', name: 'Video URL', type: 'string', role: 'text', read: true, write: true }
        ];
    
        for (const basePath of basePaths) {
            await this.setObjectNotExistsAsync(basePath, {
                type: 'channel',
                common: { name: basePath.includes('messages') ? 'General Messages' : 'Messages' },
                native: {},
            });
    
            for (const state of commonStates) {
                await this.setObjectNotExistsAsync(`${basePath}.${state.id}`, {
                    type: 'state',
                    common: {
                        name: state.name,
                        type: state.type,
                        role: state.role,
                        read: state.read,
                        write: state.write,
                        states: state.states
                    },
                    native: {},
                });
            }
        }
    }
    
    
    
    
}

if (module.parent) {
    module.exports = (options) => new Iobapp(options);
} else {
    new Iobapp();
}
