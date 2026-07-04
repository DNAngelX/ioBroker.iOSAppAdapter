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
        this.messageQueue = new Map(); // Queue for messages to be sent later
        this.clients = new Map(); // Store clients with their IDs
        this.relayWakeInterval = null;
        this.relayLastWakeByDevice = new Map();
    }

    async onReady() {
        this.log.debug('Adapter ready: Initializing express app.');
        this.app.use(bodyParser.json({
            strict: true,
            verify: (req, res, buf) => {
                try {
                    JSON.parse(buf);
                } catch (e) {
                    this.log.error(`Invalid JSON received: ${buf.toString()}`);
                    throw new Error('Invalid JSON');
                }
            }
        }));

        const wsPort = this.config.wsPort || 9192;

        this.initializeWebSocket(wsPort);
        this.startRelayWakeMonitor();

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
            if (this.relayWakeInterval) {
                clearInterval(this.relayWakeInterval);
                this.relayWakeInterval = null;
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
                this.log.debug(`Received request to save settings: ${JSON.stringify(obj.message)}`);
                this.config.username = obj.message.username;
                this.config.password = obj.message.password;
                this.config.wsPort = obj.message.wsPort;
                this.config.relayEnabled = obj.message.relayEnabled;
                this.config.relayUrl = obj.message.relayUrl;
                this.config.relayApiKey = obj.message.relayApiKey;
                this.config.wakeAfterMinutes = obj.message.wakeAfterMinutes;
                this.config.minWakeIntervalMinutes = obj.message.minWakeIntervalMinutes;
                this.saveConfig(() => {
                    this.sendTo(obj.from, obj.command, { result: 'Settings saved' }, obj.callback);
                    this.log.debug('Settings saved successfully.');
                });
            }
        }
    }

    async saveConfig(callback) {
        try {
            const instanceId = `system.adapter.${this.namespace}`;
            const instanceObject = await this.getForeignObjectAsync(instanceId);
            if (instanceObject) {
                instanceObject.native = {
                    ...instanceObject.native,
                    username: this.config.username,
                    password: this.config.password,
                    wsPort: this.config.wsPort,
                    relayEnabled: this.config.relayEnabled,
                    relayUrl: this.config.relayUrl,
                    relayApiKey: this.config.relayApiKey,
                    wakeAfterMinutes: this.config.wakeAfterMinutes,
                    minWakeIntervalMinutes: this.config.minWakeIntervalMinutes,
                };
                await this.setForeignObjectAsync(instanceId, instanceObject);
            }
        } catch (err) {
            this.log.error(`Error saving adapter settings: ${err}`);
        } finally {
            callback();
        }
    }

    async handleOnlineState(socket) {
        this.log.debug('Received request for onlineState.');

        try {
            const systemConfig = await this.getForeignObjectAsync('system.config');
            const latitude = systemConfig && systemConfig.common && systemConfig.common.latitude;
            const longitude = systemConfig && systemConfig.common && systemConfig.common.longitude;

            socket.send(JSON.stringify({
                action: 'onlineState',
                data: { online: true, location: `${latitude},${longitude}` }
            }));
        } catch (err) {
            this.log.error(`Error getting system config: ${err}`);
            socket.send(JSON.stringify({
                action: 'onlineState',
                data: { online: true, location: { latitude: null, longitude: null }, error: 'Could not retrieve location information' }
            }));
        }
    }

    async handleGetPersons(socket) {
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
            this.log.debug(`Sending persons: ${JSON.stringify(personsArray)}`);
            socket.send(JSON.stringify({ action: 'getPersons', data: personsArray }));
        } catch (err) {
            this.log.error(`Error getting persons: ${err}`);
            socket.send(JSON.stringify({ action: 'getPersons', error: 'Error getting persons' }));
        }
    }

    async handleGetDevices(socket, data) {
        const { person } = data;
        this.log.debug(`Received request to get devices for person: ${person}`);
        try {
            const objects = await this.getForeignObjectsAsync(`${this.namespace}.person.${person}.*`, 'state');
            const devices = new Set();

            for (const id in objects) {
                if (objects.hasOwnProperty(id) && !id.includes('.messages')) {  // Ignore devices named "messages"
                    const deviceMatch = id.match(/^iobapp\.\d+\.person\.[^\.]+\.([^\.]+)/);
                    if (deviceMatch) {
                        devices.add(deviceMatch[1]);
                    }
                }
            }

            const devicesArray = Array.from(devices).map(device => ({ device }));
            this.log.debug(`Sending devices: ${JSON.stringify(devicesArray)}`);
            socket.send(JSON.stringify({ action: 'getDevices', data: devicesArray }));
        } catch (err) {
            this.log.error(`Error getting devices for person ${person}: ${err}`);
            socket.send(JSON.stringify({ action: 'getDevices', error: `Error getting devices for person ${person}` }));
        }
    }

    async handlePostPersons(socket, data) {
        const { person } = data;
        this.log.debug(`Received request to create person: ${person}`);
        try {
            await this.setObjectNotExistsAsync(`${this.namespace}.person.${person}`, {
                type: 'channel',
                common: { name: person },
                native: {},
            });
            this.log.debug(`Person ${person} created.`);
            socket.send(JSON.stringify({ action: 'postPersons', success: true }));
        } catch (err) {
            this.log.error(`Error creating person ${person}: ${err}`);
            socket.send(JSON.stringify({ action: 'postPersons', error: `Error creating person ${person}` }));
        }
    }

    async handlePostDevices(socket, data) {
        const { person, device, sensors } = data; // Expecting sensors as an array of objects
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
                const sensorPath = `${basePath}.${sensor.id}`;
                await this.setObjectNotExistsAsync(sensorPath, {
                    type: 'state',
                    common: {
                        name: sensor.name,
                        type: sensor.type,
                        role: sensor.role || 'value',
                        unit: sensor.unit || '',
                        read: true,
                        write: true,
                        states: sensor.states || undefined
                    },
                    native: {},
                });
                this.log.debug(`Sensor ${sensor.name} created for device ${device}.`);
            }

            // Create messages folder
            await this.createAPNObjects(person, device);

            this.log.debug(`Device ${device} created for person ${person}.`);
            socket.send(JSON.stringify({ action: 'postDevices', success: true }));
        } catch (err) {
            this.log.error(`Error creating device ${device} for person ${person}: ${err}`);
            socket.send(JSON.stringify({ action: 'postDevices', error: `Error creating device ${device} for person ${person}` }));
        }
    }

    async handleSet(socket, data) {
        const { path, value } = data;
        this.log.debug(`Received request to set value for path: ${path} to ${value}`);
        try {
            const fullPath = `${this.namespace}.${path}`;
            await this.ensureStateObject(fullPath, value);
            await this.setForeignStateAsync(fullPath, { val: value, ack: true });
            this.log.debug(`Value for path ${path} set to ${value}`);
            socket.send(JSON.stringify({ action: 'set', success: true }));
        } catch (err) {
            this.log.error(`Error setting value for path ${path}: ${err}`);
            socket.send(JSON.stringify({ action: 'set', error: `Error setting value for path ${path}` }));
        }
    }

    async ensureStateObject(id, value) {
        const existing = await this.getForeignObjectAsync(id);
        if (existing) return;

        const segments = id.split('.');
        for (let index = 2; index < segments.length - 1; index++) {
            const channelId = segments.slice(0, index + 1).join('.');
            await this.setObjectNotExistsAsync(channelId, {
                type: 'channel',
                common: { name: segments[index] },
                native: {},
            });
        }

        const valueType = typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string';
        await this.setObjectNotExistsAsync(id, {
            type: 'state',
            common: {
                name: segments[segments.length - 1],
                type: valueType,
                role: valueType === 'boolean' ? 'indicator' : 'value',
                read: true,
                write: true,
            },
            native: {},
        });
    }

    async handleSetPresence(socket, data) {
        const { locationName, person, presence, distance } = data;
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

                await this.setStateAsync(pathPresence, { val: presence, ack: true });
                this.log.debug(`Presence for ${person} in ${locationName} set to ${presence}`);
            } catch (err) {
                this.log.error(`Error setting presence for ${person} in ${locationName}: ${err}`);
                socket.send(JSON.stringify({ action: 'setPresence', error: `Error setting presence for ${person} in ${locationName}` }));
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

                await this.setStateAsync(pathDistance, { val: distance, ack: true });
                this.log.debug(`Distance for ${person} in ${locationName} set to ${distance}`);
            } catch (err) {
                this.log.error(`Error setting distance for ${person} in ${locationName}: ${err}`);
                socket.send(JSON.stringify({ action: 'setPresence', error: `Error setting distance for ${person} in ${locationName}` }));
                return;
            }
        }

        socket.send(JSON.stringify({ action: 'setPresence', success: true }));
    }

    async handleGetZones(socket) {
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
            this.log.debug(`Sending zones: ${JSON.stringify(zonesArray)}`);
            socket.send(JSON.stringify({ action: 'getZones', data: zonesArray }));
        } catch (err) {
            this.log.error(`Error getting zones: ${err}`);
            socket.send(JSON.stringify({ action: 'getZones', error: 'Error getting zones' }));
        }
    }

    async handleTagsTrigger(socket, data) {
        const { tagId } = data;
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
                socket.send(JSON.stringify({ action: 'tagsTrigger', success: true }));
            } else {
                this.log.debug(`Tag ${tagId} not found in ioBroker`);
                socket.send(JSON.stringify({ action: 'tagsTrigger', error: 'missing tag' }));
            }
        } catch (err) {
            this.log.error(`Error handling tagsTrigger for tag ID ${tagId}: ${err}`);
            socket.send(JSON.stringify({ action: 'tagsTrigger', error: `Error handling tagsTrigger for tag ID ${tagId}` }));
        }
    }

    async handleCreateTag(socket, data) {
        const { tagId, name } = data;
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
            socket.send(JSON.stringify({ action: 'createTag', success: true }));
        } catch (err) {
            this.log.error(`Error creating tag ${tagId}: ${err}`);
            socket.send(JSON.stringify({ action: 'createTag', error: `Error creating tag ${tagId}` }));
        }
    }

    handleHello(socket) {
        socket.send(JSON.stringify({
            action: 'hello',
            data: {
                protocolVersion: 2,
                adapterVersion: this.version || 'unknown',
                capabilities: [
                    'getActionCatalog',
                    'executeAction',
                    'requestSensorRefresh',
                    'notificationCommands',
                    'diagnostics',
                    'silentPushWake'
                ],
                supportedActions: [
                    'setDeviceToken',
                    'onlineState',
                    'getPersons',
                    'getDevices',
                    'postPersons',
                    'postDevices',
                    'set',
                    'setPresence',
                    'notification',
                    'notificationAck',
                    'getZones',
                    'tagsTrigger',
                    'createTag',
                    'getActionCatalog',
                    'executeAction',
                    'requestSensorRefresh',
                    'notificationCommand'
                ]
            }
        }));
    }

    async handleGetActionCatalog(socket) {
        try {
            const objects = await this.getForeignObjectsAsync(`${this.namespace}.tags.*`, 'state');
            const tagActions = Object.entries(objects || {}).map(([id, object]) => {
                const tagId = id.split('.').pop();
                return {
                    id: `tag:${tagId}`,
                    name: object.common && object.common.name ? object.common.name : tagId,
                    type: 'tagTrigger'
                };
            });

            socket.send(JSON.stringify({
                action: 'getActionCatalog',
                data: {
                    actions: [
                        {
                            id: 'requestSensorRefresh',
                            name: 'Sensoren aktualisieren',
                            type: 'runtime'
                        },
                        {
                            id: 'request_location_update',
                            name: 'Standort senden',
                            type: 'notificationCommand'
                        },
                        {
                            id: 'command_update_sensors',
                            name: 'Sensoren per Command aktualisieren',
                            type: 'notificationCommand'
                        },
                        {
                            id: 'update_widgets',
                            name: 'Widgets aktualisieren',
                            type: 'notificationCommand'
                        },
                        {
                            id: 'update_watch',
                            name: 'Watch aktualisieren',
                            type: 'notificationCommand'
                        },
                        {
                            id: 'clear_notification',
                            name: 'Notifications löschen',
                            type: 'notificationCommand'
                        },
                        ...tagActions
                    ]
                }
            }));
        } catch (err) {
            this.log.error(`Error getting action catalog: ${err}`);
            socket.send(JSON.stringify({ action: 'getActionCatalog', error: 'Error getting action catalog' }));
        }
    }

    async handleExecuteAction(socket, data) {
        const { actionId, payload } = data || {};
        if (!actionId) {
            socket.send(JSON.stringify({ action: 'executeAction', error: 'Missing actionId' }));
            return;
        }

        if (actionId.startsWith('tag:')) {
            const tagId = actionId.substring(4);
            const tagPath = `${this.namespace}.tags.${tagId}`;
            try {
                const tagObj = await this.getForeignObjectAsync(tagPath);
                if (!tagObj) {
                    socket.send(JSON.stringify({ action: 'executeAction', error: 'missing tag' }));
                    return;
                }
                await this.setStateAsync(tagPath, true, true);
                setTimeout(async () => {
                    await this.setStateAsync(tagPath, false, true);
                }, 1000);
                socket.send(JSON.stringify({ action: 'executeAction', success: true, data: { actionId } }));
            } catch (err) {
                this.log.error(`Error executing action ${actionId}: ${err}`);
                socket.send(JSON.stringify({ action: 'executeAction', error: `Error executing action ${actionId}` }));
            }
            return;
        }

        if (actionId === 'requestSensorRefresh') {
            socket.send(JSON.stringify({ action: 'requestSensorRefresh', data: { reason: 'executeAction', payload: payload || {} } }));
            socket.send(JSON.stringify({ action: 'executeAction', success: true, data: { actionId } }));
            return;
        }

        const notificationCommands = new Set([
            'command_update_sensors',
            'request_location_update',
            'update_widgets',
            'update_watch',
            'clear_notification'
        ]);
        if (notificationCommands.has(actionId)) {
            socket.send(JSON.stringify({ action: 'notificationCommand', data: { command: actionId, payload: payload || {} } }));
            socket.send(JSON.stringify({ action: 'executeAction', success: true, data: { actionId } }));
            return;
        }

        socket.send(JSON.stringify({ action: 'executeAction', error: `Unknown actionId ${actionId}` }));
    }

    handleRequestSensorRefresh(socket) {
        socket.send(JSON.stringify({ action: 'requestSensorRefresh', success: true }));
    }

    handleNotificationAck(socket, data) {
        this.log.debug(`Notification acknowledgment received: ${JSON.stringify(data || {})}`);
        socket.send(JSON.stringify({ action: 'notificationAck', success: true }));
    }

    isRelayEnabled() {
        return Boolean(this.config.relayEnabled && this.config.relayUrl && this.config.relayApiKey);
    }

    relayUrl(path) {
        return `${String(this.config.relayUrl || '').replace(/\/+$/, '')}${path}`;
    }

    async relayRequest(path, options = {}) {
        const response = await fetch(this.relayUrl(path), {
            ...options,
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${this.config.relayApiKey}`,
                ...(options.headers || {}),
            },
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(body.error || `Relay request failed with ${response.status}`);
        }
        return body;
    }

    async registerRelayDevice({ person, device, appDeviceId, apnsToken, lastSeenAt }) {
        if (!this.isRelayEnabled() || !appDeviceId || !apnsToken) return;
        try {
            await this.relayRequest('/api/v1/devices/register', {
                method: 'POST',
                body: JSON.stringify({
                    person,
                    device,
                    appDeviceId,
                    apnsToken,
                    lastSeenAt,
                }),
            });
            this.log.debug(`Registered relay device ${person}.${device} (${appDeviceId})`);
        } catch (err) {
            this.log.warn(`Relay device registration failed for ${person}.${device}: ${err.message}`);
        }
    }

    async wakeRelayDevice(appDeviceId, reason) {
        if (!this.isRelayEnabled() || !appDeviceId) return false;
        const minWakeIntervalMinutes = Number(this.config.minWakeIntervalMinutes || 10);
        const minIntervalMs = Math.max(minWakeIntervalMinutes, 1) * 60 * 1000;
        const lastWake = this.relayLastWakeByDevice.get(appDeviceId) || 0;
        if (Date.now() - lastWake < minIntervalMs) {
            this.log.debug(`Skipping relay wake for ${appDeviceId}: local throttle`);
            return false;
        }

        try {
            const result = await this.relayRequest(`/api/v1/devices/${encodeURIComponent(appDeviceId)}/wake`, {
                method: 'POST',
                body: JSON.stringify({
                    reason,
                    minIntervalMs,
                    payload: {
                        adapterNamespace: this.namespace,
                    },
                }),
            });
            if (!result.skipped) {
                this.relayLastWakeByDevice.set(appDeviceId, Date.now());
                this.log.info(`Relay wake sent for ${appDeviceId}: ${reason}`);
            } else {
                this.log.debug(`Relay wake skipped for ${appDeviceId}: ${result.reason || 'unknown'}`);
            }
            return true;
        } catch (err) {
            this.log.warn(`Relay wake failed for ${appDeviceId}: ${err.message}`);
            return false;
        }
    }

    startRelayWakeMonitor() {
        if (this.relayWakeInterval) {
            clearInterval(this.relayWakeInterval);
            this.relayWakeInterval = null;
        }
        if (!this.isRelayEnabled()) {
            this.log.info('Silent Push relay disabled or incomplete.');
            return;
        }

        this.log.info(`Silent Push relay enabled: ${this.config.relayUrl}`);
        this.relayWakeInterval = setInterval(() => {
            this.checkStaleRelayDevices().catch(err => this.log.warn(`Relay stale-device check failed: ${err.message}`));
        }, 60 * 1000);
        this.checkStaleRelayDevices().catch(err => this.log.warn(`Initial relay stale-device check failed: ${err.message}`));
    }

    async checkStaleRelayDevices() {
        if (!this.isRelayEnabled()) return;
        const wakeAfterMinutes = Number(this.config.wakeAfterMinutes || 10);
        const minAgeSeconds = Math.max(wakeAfterMinutes, 1) * 60;
        const tokenStates = await this.getStatesAsync(`${this.namespace}.person.*.*.device_token`);
        const tokenEntries = Object.entries(tokenStates || {});

        for (const [tokenId, tokenState] of tokenEntries) {
            const match = tokenId.match(new RegExp(`^${this.namespace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.person\\.([^.]+)\\.([^.]+)\\.device_token$`));
            if (!match || !tokenState || !tokenState.val) continue;

            const [, person, device] = match;
            const basePath = `${this.namespace}.person.${person}.${device}`;
            const clientState = await this.getStateAsync(`${basePath}.ws_device_id`);
            const lastSeenState = await this.getStateAsync(`${basePath}.sensors.last_seen_timestamp`);
            const appDeviceId = clientState && clientState.val ? String(clientState.val) : `${person}.${device}`;
            const apnsToken = String(tokenState.val);
            const lastSeenSeconds = lastSeenState && Number(lastSeenState.val) > 0 ? Number(lastSeenState.val) : 0;
            const lastSeenAt = lastSeenSeconds > 0 ? new Date(lastSeenSeconds * 1000).toISOString() : null;

            await this.registerRelayDevice({ person, device, appDeviceId, apnsToken, lastSeenAt });

            if (!lastSeenSeconds) {
                this.log.debug(`Skipping relay wake for ${person}.${device}: missing last_seen_timestamp`);
                continue;
            }
            const ageSeconds = Date.now() / 1000 - lastSeenSeconds;
            if (ageSeconds >= minAgeSeconds) {
                await this.wakeRelayDevice(appDeviceId, `stale_last_seen_${Math.round(ageSeconds)}s`);
            }
        }
    }

    initializeWebSocket(wsPort) {
        this.wsServer = new WebSocket.Server({ port: wsPort });
        this.clients = new Map(); // Store clients with their IDs

        this.wsServer.on('connection', (socket) => {
            this.log.info('WebSocket connection established.');

            socket.on('message', (message) => {
                this.log.info(`Received message: ${message}`);
                this.handleWebSocketMessage(socket, message);
            });

            socket.on('close', () => {
                this.log.info('WebSocket connection closed.');
                this.clients.forEach((client, id) => {
                    if (client.socket === socket) {
                        this.clients.delete(id);
                        this.setConnectionState(id, false);
                    }
                });
            });

        });

        this.wsServer.on('error', (error) => {
            this.log.error(`WebSocket error: ${error.message}`);
        });

        this.log.info(`WebSocket server listening on port ${wsPort}`);
    }

    async handleWebSocketMessage(socket, message) {
        try {
            const parsedMessage = JSON.parse(message);
            const { action, data, username, password, clientId, person, device } = parsedMessage;
    
            if (!this.authenticate(username, password)) {
                socket.send(JSON.stringify({ error: 'Authentication failed' }));
                return;
            }
    
            switch (action) {
                case 'hello':
                    this.handleHello(socket);
                    break;
                case 'setDeviceToken':
                    const deviceToken = data.deviceToken;
                    const person = data.person;
                    const device = data.device;
                    socket.clientId = clientId;
                    socket.deviceToken = deviceToken;
                    this.clients.set(clientId, socket);

                    await this.setObjectNotExistsAsync(`${this.namespace}.person.${person}.${device}.ws_device_id`, {
                        type: 'state',
                        common: {
                            name: 'WebSocket Device ID',
                            type: 'string',
                            role: 'text',
                            read: true,
                            write: false,
                        },
                        native: {},
                    });

                    await this.setObjectNotExistsAsync(`${this.namespace}.person.${person}.${device}.connection`, {
                        type: 'state',
                        common: {
                            name: 'Connected',
                            type: 'boolean',
                            role: 'indicator.connected',
                            read: true,
                            write: false,
                        },
                        native: {},
                    });

                    await this.setObjectNotExistsAsync(`${this.namespace}.person.${person}.${device}.device_token`, {
                        type: 'state',
                        common: {
                            name: 'APNs Device Token',
                            type: 'string',
                            role: 'text',
                            read: true,
                            write: false,
                        },
                        native: {},
                    });

                    await this.setStateAsync(`${this.namespace}.person.${person}.${device}.ws_device_id`, clientId, true);
                    await this.setStateAsync(`${this.namespace}.person.${person}.${device}.device_token`, deviceToken, true);
                    await this.setConnectionState(`${person}.${device}`, true);
                    await this.registerRelayDevice({
                        person,
                        device,
                        appDeviceId: clientId,
                        apnsToken: deviceToken,
                        lastSeenAt: new Date().toISOString(),
                    });
                    socket.send(JSON.stringify({ action: 'setDeviceToken', success: true }));
                    this.sendQueuedMessages(socket);
                    break;
                case 'onlineState':
                    this.handleOnlineState(socket);
                    break;
                case 'getPersons':
                    this.handleGetPersons(socket);
                    break;
                case 'getDevices':
                    this.handleGetDevices(socket, data);
                    break;
                case 'postPersons':
                    this.handlePostPersons(socket, data);
                    break;
                case 'postDevices':
                    this.handlePostDevices(socket, data);
                    break;
                case 'set':
                    this.handleSet(socket, data);
                    break;
                case 'setPresence':
                    this.handleSetPresence(socket, data);
                    break;
                case 'getZones':
                    this.handleGetZones(socket);
                    break;
                case 'tagsTrigger':
                    this.handleTagsTrigger(socket, data);
                    break;
                case 'createTag':
                    this.handleCreateTag(socket, data);
                    break;
                case 'getActionCatalog':
                    this.handleGetActionCatalog(socket);
                    break;
                case 'executeAction':
                    this.handleExecuteAction(socket, data);
                    break;
                case 'requestSensorRefresh':
                    this.handleRequestSensorRefresh(socket);
                    break;
                case 'notificationAck':
                    this.handleNotificationAck(socket, data);
                    break;
                default:
                    this.log.warn(`Unknown action: ${action}`);
                    socket.send(JSON.stringify({ error: 'Unknown action' }));
            }
        } catch (error) {
            this.log.error(`Error handling WebSocket message: ${error.message}`);
            socket.send(JSON.stringify({ error: 'Invalid message format' }));
        }
    }
    

    sendMessageToClient(clientId, message) {
        const client = this.clients.get(clientId);
        if (client && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(message));
            this.log.info(`Message sent to client ${clientId}: ${JSON.stringify(message)}`);
        } else {
            this.queueMessageForClient(clientId, message);
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

    queueMessageForClient(clientId, message) {
        if (!this.messageQueue) {
            this.messageQueue = new Map();
        }
    
        if (!this.messageQueue.has(clientId)) {
            this.messageQueue.set(clientId, []);
        }
    
        const clientQueue = this.messageQueue.get(clientId);
        clientQueue.push(message);
        this.messageQueue.set(clientId, clientQueue);
    
        this.log.debug(`Message queued for client ${clientId}: ${JSON.stringify(message)} Queue: ${JSON.stringify(Array.from(this.messageQueue.entries()))}`);
    }
    

    sendQueuedMessages(socket) {
        
        const clientId = socket.clientId;
        if (!clientId || !this.messageQueue.has(clientId)) {
            this.log.debug(`sendQueuedMessages queue for client ${clientId}`);
            return;
        }
    
        const queue = this.messageQueue.get(clientId);
        this.log.debug(`sendQueuedMessages queue for client ${clientId}: ${JSON.stringify(queue)}`);
    
        while (queue.length > 0) {
            const message = queue.shift();
            if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify(message));
                this.log.info(`Queued message sent to client ${clientId}: ${JSON.stringify(message)}`);
            } else {
                queue.unshift(message);
                break;
            }
        }
    
        if (queue.length === 0) {
            this.messageQueue.delete(clientId);
        }
    }
    

    async generatePayload(id) {
        const [namespace, person, device, ...rest] = id.split('.').slice(2);
        let basePath;
    
        if (person === 'send') {
            basePath = `${this.namespace}.messages`;
        }  else if (device === 'messages') {
            basePath = `${this.namespace}.person.${person}.messages`;
        } else {
            basePath = `${this.namespace}.person.${person}.${device}.messages`;
        }
        this.log.debug(`namespace ${basePath}`);
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
    
            /** @type {Record<string, unknown>} */
            const alert = {};
            if (title) alert.title = title;
            if (subtitle) alert.subtitle = subtitle;
            if (body) alert.body = body;

            /** @type {Record<string, unknown>} */
            const aps = {};
            if (Object.keys(alert).length > 0) aps.alert = alert;
            if (sound) aps.sound = sound;

            /** @type {Record<string, unknown>} */
            const notification = { aps };
            if (bodyHtml) notification['body-html'] = bodyHtml;
            if (mediaUrl) notification['media-url'] = mediaUrl;
            if (imageUrl) notification['image-url'] = imageUrl;
            if (videoUrl) notification['video-url'] = videoUrl;
    
            const payload = JSON.stringify(notification);
            await this.setStateAsync(`${basePath}.payload`, payload, true);
            this.log.debug(`Payload generated for ${basePath}: ${payload}`);
        } catch (err) {
            this.log.error(`Error generating payload for ${basePath}: ${err.message}`);
        }
    }

    async handleAPNMessage(id) {
        const [namespace, person, device, ...rest] = id.split('.').slice(2);
        let basePath, clientIds;
        
        if (device === 'messages') {
            basePath = `${this.namespace}.person.${person}.messages`;
            const deviceStates = await this.getStatesAsync(`${this.namespace}.person.${person}.*.ws_device_id`);
            clientIds = Object.values(deviceStates).map(state => state.val).filter(val => val);
        } else if (person === 'payload') {
            basePath = `${this.namespace}.messages`;
            const allDeviceStates = await this.getStatesAsync(`${this.namespace}.person.*.*.ws_device_id`);
            clientIds = Object.values(allDeviceStates).map(state => state.val).filter(val => val);
        } else {
            basePath = `${this.namespace}.person.${person}.${device}.messages`;
            const deviceState = await this.getStateAsync(`${this.namespace}.person.${person}.${device}.ws_device_id`);
            clientIds = deviceState ? [deviceState.val] : [];
        }
    
        try {
            const payloadState = await this.getStateAsync(`${basePath}.payload`);
            const payload = payloadState ? payloadState.val : null;
    
            if (payload) {
                const message = { action: 'notification', payload: JSON.parse(String(payload)) };
    
                for (const clientId of clientIds) {
                    if (clientId) {
                        this.sendMessageToClient(clientId, message);
                    } else {
                        this.log.warn(`Ignoring device with missing client ID for ${clientId}`);
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

    async createAPNObjects(person, device) {
        const basePaths = [
            `${this.namespace}.person.${person}.${device}.messages`,
            `${this.namespace}.person.${person}.messages`,
            `${this.namespace}.messages`
        ];

        /** @type {{ id: string, name: string, type: ioBroker.CommonType, role: string, read: boolean, write: boolean, states?: Record<string, string> }[]} */
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
            { id: 'video-url', name: 'Video URL', type: 'string', role: 'text', read: true, write: true },
            { id: 'ws_device_id', name: 'WebSocket Device ID', type: 'string', role: 'text', read: true, write: false }
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

    async setConnectionState(devicePath, connected) {
        const statePath = `${this.namespace}.person.${devicePath}.connection`;
        await this.setObjectNotExistsAsync(statePath, {
            type: 'state',
            common: {
                name: 'Connection State',
                type: 'boolean',
                role: 'indicator.connected',
                read: true,
                write: false,
            },
            native: {},
        });
        await this.setStateAsync(statePath, connected, true);
    }

    authenticate(username, password) {
        return username === this.config.username && password === this.config.password;
    }
}

if (require.main !== module) {
    module.exports = (options) => new Iobapp(options);
} else {
    new Iobapp();
}
