"use strict";

const { expect } = require("chai");
const { readFileSync } = require("fs");
const { join } = require("path");
const proxyquire = require("proxyquire").noCallThru();

class FakeAdapter {
	constructor(options) {
		this.options = options;
		this.namespace = "iobapp.0";
		this.version = "0.2.1";
		this.config = {};
		this.log = {
			debug: () => {},
			error: () => {},
			info: () => {},
			warn: () => {},
		};
	}

	on() {}
}

function makeAdapter() {
	const createAdapter = proxyquire("./main", {
		"@iobroker/adapter-core": {
			Adapter: FakeAdapter,
		},
	});
	return createAdapter({});
}

function makeSocket() {
	return {
		/** @type {any[]} */
		sent: [],
		send(payload) {
			this.sent.push(JSON.parse(payload));
		},
	};
}

describe("Protocol v2 WebSocket contract", () => {
	it("registers the materialize admin tab for indoor management", () => {
		const ioPackage = JSON.parse(readFileSync(join(__dirname, "io-package.json"), "utf8"));

		expect(ioPackage.common.adminUI).to.deep.include({
			config: "materialize",
			tab: "materialize",
		});
		expect(ioPackage.common.adminTab).to.deep.include({
			singleton: true,
		});
		expect(ioPackage.common.adminTab.name).to.deep.include({
			en: "iOS App",
			de: "iOS App",
		});
	});

	it("responds to hello with versioned capabilities", () => {
		const adapter = makeAdapter();
		const socket = makeSocket();

		adapter.handleHello(socket);

		expect(socket.sent).to.have.length(1);
		expect(socket.sent[0]).to.deep.include({ action: "hello" });
		expect(socket.sent[0].data.protocolVersion).to.equal(2);
		expect(socket.sent[0].data.adapterVersion).to.equal("0.2.1");
		expect(socket.sent[0].data.capabilities).to.include.members([
			"getActionCatalog",
			"executeAction",
			"requestSensorRefresh",
			"notificationCommands",
			"diagnostics",
			"silentPushWake",
			"indoorPositioning",
		]);
		expect(socket.sent[0].data.supportedActions).to.include.members([
			"setDeviceToken",
			"set",
			"setPresence",
			"notification",
			"notificationAck",
			"getActionCatalog",
			"executeAction",
			"requestSensorRefresh",
			"notificationCommand",
			"getIndoorRooms",
			"indoorBeaconScan",
		]);
	});

	it("returns runtime and NFC tag actions in the action catalog", async () => {
		const adapter = makeAdapter();
		adapter.getForeignObjectsAsync = async () => ({
			"iobapp.0.tags.frontdoor": {
				common: { name: "Front Door" },
			},
		});
		const socket = makeSocket();

		await adapter.handleGetActionCatalog(socket);

		expect(socket.sent).to.have.length(1);
		expect(socket.sent[0]).to.deep.equal({
			action: "getActionCatalog",
			data: {
				actions: [
					{
						id: "requestSensorRefresh",
						name: "Sensoren aktualisieren",
						type: "runtime",
					},
					{
						id: "request_location_update",
						name: "Standort senden",
						type: "notificationCommand",
					},
					{
						id: "command_update_sensors",
						name: "Sensoren per Command aktualisieren",
						type: "notificationCommand",
					},
					{
						id: "update_widgets",
						name: "Widgets aktualisieren",
						type: "notificationCommand",
					},
					{
						id: "update_watch",
						name: "Watch aktualisieren",
						type: "notificationCommand",
					},
					{
						id: "clear_notification",
						name: "Notifications löschen",
						type: "notificationCommand",
					},
					{
						id: "request_indoor_scan",
						name: "Indoor-Scan auslösen",
						type: "notificationCommand",
					},
					{
						id: "tag:frontdoor",
						name: "Front Door",
						type: "tagTrigger",
					},
				],
			},
		});
	});

	it("maps executeAction notification commands to notificationCommand", async () => {
		const adapter = makeAdapter();
		const socket = makeSocket();

		await adapter.handleExecuteAction(socket, {
			actionId: "request_location_update",
			payload: { source: "test" },
		});

		expect(socket.sent).to.deep.equal([
			{
				action: "notificationCommand",
				data: {
					command: "request_location_update",
					payload: { source: "test" },
				},
			},
			{
				action: "executeAction",
				success: true,
				data: {
					actionId: "request_location_update",
				},
			},
		]);
	});

	it("maps executeAction requestSensorRefresh to a refresh request and success ack", async () => {
		const adapter = makeAdapter();
		const socket = makeSocket();

		await adapter.handleExecuteAction(socket, {
			actionId: "requestSensorRefresh",
			payload: { source: "test" },
		});

		expect(socket.sent).to.deep.equal([
			{
				action: "requestSensorRefresh",
				data: {
					reason: "executeAction",
					payload: { source: "test" },
				},
			},
			{
				action: "executeAction",
				success: true,
				data: {
					actionId: "requestSensorRefresh",
				},
			},
		]);
	});

	it("acknowledges notificationAck without changing the existing notification payload contract", () => {
		const adapter = makeAdapter();
		const socket = makeSocket();

		adapter.handleNotificationAck(socket, {
			payload: {
				aps: {
					alert: {
						title: "Test",
					},
				},
			},
		});

		expect(socket.sent).to.deep.equal([
			{
				action: "notificationAck",
				success: true,
			},
		]);
	});

	it("returns ioBroker enum rooms for indoor learning", async () => {
		const adapter = makeAdapter();
		adapter.getForeignObjectsAsync = async pattern => {
			expect(pattern).to.equal("enum.rooms.*");
			return {
				"enum.rooms.living_room": {
					common: { name: { en: "Living room", de: "Wohnzimmer" } },
				},
				"enum.rooms.kitchen": {
					common: { name: "Küche" },
				},
			};
		};
		const socket = makeSocket();

		await adapter.handleGetIndoorRooms(socket);

		expect(socket.sent).to.deep.equal([
			{
				action: "getIndoorRooms",
				data: {
					rooms: [
						{ id: "kitchen", name: "Küche" },
						{ id: "living_room", name: "Wohnzimmer" },
					],
				},
			},
		]);
	});

	it("returns learned indoor areas as room options when enum rooms are empty", async () => {
		const adapter = makeAdapter();
		adapter.getForeignObjectsAsync = async pattern => {
			if (pattern === "enum.rooms.*") return {};
			throw new Error(`Unexpected pattern ${pattern}`);
		};
		adapter.getStatesAsync = async pattern => {
			expect(pattern).to.equal("iobapp.0.indoor.areas.*.name");
			return {
				"iobapp.0.indoor.areas.cheerroom.name": { val: "Cheerroom" },
				"iobapp.0.indoor.areas.sofa-ecke.name": { val: "Sofa Ecke" },
			};
		};
		const socket = makeSocket();

		await adapter.handleGetIndoorRooms(socket);

		expect(socket.sent).to.deep.equal([
			{
				action: "getIndoorRooms",
				data: {
					rooms: [
						{ id: "cheerroom", name: "Cheerroom", source: "indoorArea" },
						{ id: "sofa-ecke", name: "Sofa Ecke", source: "indoorArea" },
					],
				},
			},
		]);
	});

	it("falls back to the enum object view when room pattern lookup is empty", async () => {
		const adapter = makeAdapter();
		adapter.getForeignObjectsAsync = async pattern => {
			expect(pattern).to.equal("enum.rooms.*");
			return {};
		};
		adapter.getObjectViewAsync = async (design, search, params) => {
			expect(design).to.equal("system");
			expect(search).to.equal("enum");
			expect(params).to.deep.equal({
				startkey: "enum.rooms.",
				endkey: "enum.rooms.\u9999",
			});
			return {
				rows: [
					{
						id: "enum.rooms.buero-jan",
						value: { common: { name: "Büro Jan" } },
					},
					{
						id: "enum.rooms.kueche",
						value: { common: { name: { en: "Kitchen", de: "Küche" } } },
					},
				],
			};
		};
		adapter.getStatesAsync = async () => ({});
		const socket = makeSocket();

		await adapter.handleGetIndoorRooms(socket);

		expect(socket.sent).to.deep.equal([
			{
				action: "getIndoorRooms",
				data: {
					rooms: [
						{ id: "buero-jan", name: "Büro Jan" },
						{ id: "kueche", name: "Küche" },
					],
				},
			},
		]);
	});

	it("stores indoor beacon scans and writes a learning fingerprint", async () => {
		const adapter = makeAdapter();
		const objects = [];
		const states = [];
		adapter.setObjectNotExistsAsync = async (id, object) => objects.push({ id, object });
		adapter.setStateAsync = async (id, val, ack) => states.push({ id, val, ack });
		adapter.getStatesAsync = async () => ({});
		const socket = makeSocket();

		await adapter.handleIndoorBeaconScan(socket, {
			person: "Jan",
			device: "iPhone",
			trigger: "learning",
			timestamp: "2026-07-12T20:00:00.000Z",
			learningAreaId: "wohnzimmer-sofa",
			learningAreaName: "Wohnzimmer Sofa",
			beacons: [
				{
					id: "shelly-kueche",
					name: "Küche",
					localName: "Shelly",
					rssi: -62,
					txPower: 0,
					connectable: true,
					services: ["fcd2"],
					manufacturerData: "0102",
				},
			],
		});

		expect(objects.map(entry => entry.id)).to.include.members([
			"iobapp.0.indoor.beacons.shelly-kueche",
			"iobapp.0.indoor.beacons.shelly-kueche.classification",
			"iobapp.0.indoor.beacons.shelly-kueche.assigned_area",
			"iobapp.0.indoor.areas.wohnzimmer-sofa",
			"iobapp.0.person.Jan.iPhone.indoor.last_scan",
			"iobapp.0.person.Jan.iPhone.indoor.current_area",
		]);
		expect(states).to.deep.include.members([
			{ id: "iobapp.0.indoor.beacons.shelly-kueche.last_rssi", val: -62, ack: true },
			{ id: "iobapp.0.indoor.areas.wohnzimmer-sofa.name", val: "Wohnzimmer Sofa", ack: true },
			{ id: "iobapp.0.person.Jan.iPhone.indoor.last_scan_trigger", val: "learning", ack: true },
			{ id: "iobapp.0.person.Jan.iPhone.indoor.current_area", val: "wohnzimmer-sofa", ack: true },
		]);
		const fingerprint = states.find(entry => entry.id === "iobapp.0.indoor.areas.wohnzimmer-sofa.fingerprint_json");
		expect(JSON.parse(fingerprint.val)).to.deep.include({
			areaId: "wohnzimmer-sofa",
			areaName: "Wohnzimmer Sofa",
		});
		expect(socket.sent).to.deep.equal([
			{
				action: "indoorBeaconScan",
				success: true,
				data: {
					currentArea: "wohnzimmer-sofa",
					confidence: 1,
				},
			},
		]);
	});

	it("excludes ignored and mobile beacons from learned fingerprints", async () => {
		const adapter = makeAdapter();
		const states = [];
		adapter.setObjectNotExistsAsync = async () => {};
		adapter.setStateAsync = async (id, val, ack) => states.push({ id, val, ack });
		adapter.getStatesAsync = async pattern => {
			if (pattern === "iobapp.0.indoor.beacons.*.classification") {
				return {
					"iobapp.0.indoor.beacons.airpods.classification": { val: "mobile" },
					"iobapp.0.indoor.beacons.macbook.classification": { val: "ignored" },
				};
			}
			return {};
		};
		const socket = makeSocket();

		await adapter.handleIndoorBeaconScan(socket, {
			person: "Jan",
			device: "iPhone",
			trigger: "learning",
			timestamp: "2026-07-12T20:00:00.000Z",
			learningAreaId: "cheerroom",
			learningAreaName: "Cheerroom",
			beacons: [
				{ id: "shelly", name: "Shelly", rssi: -50 },
				{ id: "airpods", name: "AirPods", rssi: -42 },
				{ id: "macbook", name: "MacBook", rssi: -38 },
			],
		});

		const fingerprintWrite = states.find(entry => entry.id === "iobapp.0.indoor.areas.cheerroom.fingerprint_json");
		const fingerprint = JSON.parse(fingerprintWrite.val);
		expect(fingerprint.beacons.map(beacon => beacon.id)).to.deep.equal(["shelly"]);
		expect(socket.sent[0]).to.deep.include({ action: "indoorBeaconScan", success: true });
	});

	it("does not keep an indoor area when only a small fingerprint fraction matches", async () => {
		const adapter = makeAdapter();
		const states = [];
		const learnedBeacons = Array.from({ length: 29 }, (_value, index) => ({
			id: `beacon-${index}`,
			name: `Beacon ${index}`,
			averageRssi: -50,
			maxRssi: -50,
			count: 1,
			services: [],
			manufacturerData: "",
		}));
		adapter.setObjectNotExistsAsync = async () => {};
		adapter.setStateAsync = async (id, val, ack) => states.push({ id, val, ack });
		adapter.getStatesAsync = async pattern => {
			if (pattern === "iobapp.0.indoor.areas.*.fingerprint_json") {
				return {
					"iobapp.0.indoor.areas.chilling.fingerprint_json": {
						val: JSON.stringify({
							areaId: "chilling",
							areaName: "Chill room",
							beacons: learnedBeacons,
						}),
					},
				};
			}
			return {};
		};
		const socket = makeSocket();

		await adapter.handleIndoorBeaconScan(socket, {
			person: "Jan",
			device: "iPhone",
			trigger: "significantLocationChange",
			timestamp: "2026-07-13T08:18:48Z",
			beacons: [
				{ id: "beacon-0", name: "Beacon 0", rssi: -47 },
				{ id: "beacon-1", name: "Beacon 1", rssi: -53 },
				{ id: "beacon-2", name: "Beacon 2", rssi: -55 },
			],
		});

		expect(states).to.deep.include.members([
			{ id: "iobapp.0.person.Jan.iPhone.indoor.current_area", val: "", ack: true },
			{ id: "iobapp.0.person.Jan.iPhone.indoor.confidence", val: 0.1, ack: true },
		]);
		expect(socket.sent[0].data).to.deep.equal({
			currentArea: "",
			confidence: 0.1,
		});
	});

	it("writes area occupancy states and clears the previous area", async () => {
		const adapter = makeAdapter();
		const objects = [];
		const states = [];
		adapter.setObjectNotExistsAsync = async (id, object) => objects.push({ id, object });
		adapter.setStateAsync = async (id, val, ack) => states.push({ id, val, ack });
		adapter.getStateAsync = async id => {
			if (id === "iobapp.0.person.Jan.iPhone.indoor.current_area") {
				return { val: "chilling" };
			}
			return null;
		};
		adapter.getStatesAsync = async pattern => {
			if (pattern === "iobapp.0.indoor.areas.*.fingerprint_json") {
				return {
					"iobapp.0.indoor.areas.flur.fingerprint_json": {
						val: JSON.stringify({
							areaId: "flur",
							areaName: "Flur",
							beacons: [{ id: "fixed-flur", averageRssi: -50 }],
						}),
					},
				};
			}
			if (pattern.endsWith(".occupancy.*.present")) return {};
			return {};
		};
		const socket = makeSocket();

		await adapter.handleIndoorBeaconScan(socket, {
			person: "Jan",
			device: "iPhone",
			trigger: "manualIndoorScan",
			timestamp: "2026-07-13T09:00:00Z",
			beacons: [{ id: "fixed-flur", name: "Flur Beacon", rssi: -50 }],
		});

		expect(objects.map(entry => entry.id)).to.include.members([
			"iobapp.0.indoor.areas.flur.occupancy",
			"iobapp.0.indoor.areas.flur.occupancy.jan.present",
			"iobapp.0.indoor.areas.chilling.occupancy.jan.present",
		]);
		expect(states).to.deep.include.members([
			{ id: "iobapp.0.indoor.areas.flur.occupancy.jan.present", val: true, ack: true },
			{ id: "iobapp.0.indoor.areas.flur.occupancy.jan.last_seen", val: "2026-07-13T09:00:00Z", ack: true },
			{ id: "iobapp.0.indoor.areas.flur.occupancy.jan.device", val: "iPhone", ack: true },
			{ id: "iobapp.0.indoor.areas.chilling.occupancy.jan.present", val: false, ack: true },
		]);
	});

	it("expires stale indoor occupancy using the area timeout", async () => {
		const adapter = makeAdapter();
		const states = [];
		adapter.config.indoorPresenceTimeoutMinutes = 120;
		adapter.setObjectNotExistsAsync = async () => {};
		adapter.setStateAsync = async (id, val, ack) => states.push({ id, val, ack });
		adapter.getStatesAsync = async pattern => {
			if (pattern === "iobapp.0.person.*.*.indoor.current_area") {
				return {
					"iobapp.0.person.Jan.iPhone.indoor.current_area": { val: "schlafzimmer" },
				};
			}
			if (pattern === "iobapp.0.indoor.areas.schlafzimmer.occupancy.*.present") {
				return {
					"iobapp.0.indoor.areas.schlafzimmer.occupancy.jan.present": { val: true },
				};
			}
			return {};
		};
		adapter.getStateAsync = async id => {
			if (id === "iobapp.0.indoor.areas.schlafzimmer.settings.presence_timeout_minutes") {
				return { val: 1 };
			}
			if (id === "iobapp.0.person.Jan.iPhone.indoor.last_scan") {
				return { val: "2000-01-01T00:00:00Z" };
			}
			return null;
		};

		await adapter.expireStaleIndoorOccupancy();

		expect(states).to.deep.include.members([
			{ id: "iobapp.0.person.Jan.iPhone.indoor.current_area", val: "", ack: true },
			{ id: "iobapp.0.person.Jan.iPhone.indoor.confidence", val: 0, ack: true },
			{ id: "iobapp.0.indoor.areas.schlafzimmer.occupancy.jan.present", val: false, ack: true },
			{ id: "iobapp.0.indoor.areas.schlafzimmer.occupancy.present_count", val: 0, ack: true },
			{ id: "iobapp.0.indoor.areas.schlafzimmer.occupancy.persons_text", val: "", ack: true },
		]);
	});
});

describe("APN message routing", () => {
	function configureNotificationAdapter(adapter, options = {}) {
		const payload = options.payload || {
			aps: {
				alert: {
					title: "Test",
					body: "Message",
				},
			},
		};
		const statesByPattern = options.statesByPattern || {};
		const statesById = {
			"iobapp.0.person.Jan.iPhone.ws_device_id": { val: "jan-phone" },
			"iobapp.0.person.Jan.iPhone.messages.payload": { val: JSON.stringify(payload) },
			"iobapp.0.person.Jan.messages.payload": { val: JSON.stringify(payload) },
			"iobapp.0.messages.payload": { val: JSON.stringify(payload) },
			...(options.statesById || {}),
		};
		const sentClientIds = [];
		const setStates = [];

		adapter.getStateAsync = async id => statesById[id] || null;
		adapter.getStatesAsync = async pattern => statesByPattern[pattern] || {};
		adapter.setStateAsync = async (id, val, ack) => {
			setStates.push({ id, val, ack });
		};
		adapter.sendMessageToClient = (clientId, message) => {
			sentClientIds.push({ clientId, message });
			return true;
		};

		return { sentClientIds, setStates, payload };
	}

	it("routes device messages only to the selected device", async () => {
		const adapter = makeAdapter();
		const { sentClientIds, setStates, payload } = configureNotificationAdapter(adapter);

		await adapter.handleAPNMessage("iobapp.0.person.Jan.iPhone.messages.payload");

		expect(sentClientIds).to.deep.equal([
			{
				clientId: "jan-phone",
				message: { action: "notification", payload },
			},
		]);
		expect(setStates).to.deep.equal([
			{ id: "iobapp.0.person.Jan.iPhone.messages.payload", val: "", ack: true },
		]);
	});

	it("routes person messages to all devices of that person", async () => {
		const adapter = makeAdapter();
		const { sentClientIds, setStates, payload } = configureNotificationAdapter(adapter, {
			statesByPattern: {
				"iobapp.0.person.Jan.*.ws_device_id": {
					"iobapp.0.person.Jan.iPhone.ws_device_id": { val: "jan-phone" },
					"iobapp.0.person.Jan.Watch.ws_device_id": { val: "jan-watch" },
					"iobapp.0.person.Jan.messages.ws_device_id": { val: "not-a-device" },
				},
			},
		});

		await adapter.handleAPNMessage("iobapp.0.person.Jan.messages.payload");

		expect(sentClientIds).to.deep.equal([
			{
				clientId: "jan-phone",
				message: { action: "notification", payload },
			},
			{
				clientId: "jan-watch",
				message: { action: "notification", payload },
			},
		]);
		expect(setStates).to.deep.equal([
			{ id: "iobapp.0.person.Jan.messages.payload", val: "", ack: true },
		]);
	});

	it("routes global messages to every registered device", async () => {
		const adapter = makeAdapter();
		const { sentClientIds, setStates, payload } = configureNotificationAdapter(adapter, {
			statesByPattern: {
				"iobapp.0.person.*.*.ws_device_id": {
					"iobapp.0.person.Jan.iPhone.ws_device_id": { val: "jan-phone" },
					"iobapp.0.person.Jan.Watch.ws_device_id": { val: "jan-watch" },
					"iobapp.0.person.Eva.iPhone.ws_device_id": { val: "eva-phone" },
					"iobapp.0.person.Jan.messages.ws_device_id": { val: "not-a-device" },
				},
			},
		});

		await adapter.handleAPNMessage("iobapp.0.messages.payload");

		expect(sentClientIds).to.deep.equal([
			{
				clientId: "jan-phone",
				message: { action: "notification", payload },
			},
			{
				clientId: "jan-watch",
				message: { action: "notification", payload },
			},
			{
				clientId: "eva-phone",
				message: { action: "notification", payload },
			},
		]);
		expect(setStates).to.deep.equal([
			{ id: "iobapp.0.messages.payload", val: "", ack: true },
		]);
	});

	it("generates payloads for person-level message forms", async () => {
		const adapter = makeAdapter();
		const setStates = [];
		const statesById = {
			"iobapp.0.person.Jan.messages.title": { val: "Titel" },
			"iobapp.0.person.Jan.messages.subtitle": { val: "" },
			"iobapp.0.person.Jan.messages.body": { val: "Text" },
			"iobapp.0.person.Jan.messages.body-html": { val: "" },
			"iobapp.0.person.Jan.messages.sound": { val: "default" },
			"iobapp.0.person.Jan.messages.media-url": { val: "" },
			"iobapp.0.person.Jan.messages.image-url": { val: "" },
			"iobapp.0.person.Jan.messages.video-url": { val: "" },
		};
		adapter.getStateAsync = async id => statesById[id] || null;
		adapter.setStateAsync = async (id, val, ack) => {
			setStates.push({ id, val: JSON.parse(val), ack });
		};

		await adapter.generatePayload("iobapp.0.person.Jan.messages.send");

		expect(setStates).to.deep.equal([
			{
				id: "iobapp.0.person.Jan.messages.payload",
				val: {
					aps: {
						alert: {
							title: "Titel",
							body: "Text",
						},
						sound: "default",
					},
				},
				ack: true,
			},
		]);
	});

	it("adds APNs interruption level, relevance score and badge to generated payloads", async () => {
		const adapter = makeAdapter();
		const setStates = [];
		const statesById = {
			"iobapp.0.messages.title": { val: "Alarm" },
			"iobapp.0.messages.subtitle": { val: "" },
			"iobapp.0.messages.body": { val: "Tür offen" },
			"iobapp.0.messages.body-html": { val: "" },
			"iobapp.0.messages.sound": { val: "default" },
			"iobapp.0.messages.interruption-level": { val: "time-sensitive" },
			"iobapp.0.messages.relevance-score": { val: 0.9 },
			"iobapp.0.messages.badge": { val: 3 },
			"iobapp.0.messages.media-url": { val: "" },
			"iobapp.0.messages.image-url": { val: "" },
			"iobapp.0.messages.video-url": { val: "" },
		};
		adapter.getStateAsync = async id => statesById[id] || null;
		adapter.setStateAsync = async (id, val, ack) => {
			setStates.push({ id, val: JSON.parse(val), ack });
		};

		await adapter.generatePayload("iobapp.0.messages.send");

		expect(setStates).to.deep.equal([
			{
				id: "iobapp.0.messages.payload",
				val: {
					aps: {
						alert: {
							title: "Alarm",
							body: "Tür offen",
						},
						sound: "default",
						"interruption-level": "time-sensitive",
						"relevance-score": 0.9,
						badge: 3,
					},
				},
				ack: true,
			},
		]);
	});
});

describe("NFC tag routing", () => {
	it("normalizes friendly tag ids for create and trigger", async () => {
		const adapter = makeAdapter();
		const createdObjects = [];
		const stateWrites = [];
		const socket = makeSocket();

		adapter.setObjectNotExistsAsync = async (id, obj) => {
			createdObjects.push({ id, obj });
		};
		adapter.getForeignObjectAsync = async id => (
			id === "iobapp.0.tags.haustur-test" ? { common: { name: "Haustür Test" } } : null
		);
		adapter.setStateAsync = async (id, val, ack) => {
			stateWrites.push({ id, val, ack });
		};

		await adapter.handleCreateTag(socket, { tagId: "Haustür Test", name: "Haustür Test" });
		await adapter.handleTagsTrigger(socket, { tagId: "Haustür Test" });

		expect(createdObjects[0].id).to.equal("iobapp.0.tags.haustur-test");
		expect(createdObjects[0].obj.common.name).to.equal("Haustür Test");
		expect(socket.sent[0]).to.deep.equal({
			action: "createTag",
			success: true,
			data: { tagId: "haustur-test" },
		});
		expect(stateWrites[0]).to.deep.equal({
			id: "iobapp.0.tags.haustur-test",
			val: true,
			ack: true,
		});
	});
});
