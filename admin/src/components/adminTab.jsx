import React from "react";
import { withStyles } from "@material-ui/core/styles";
import Button from "@material-ui/core/Button";
import Card from "@material-ui/core/Card";
import CardContent from "@material-ui/core/CardContent";
import Chip from "@material-ui/core/Chip";
import Grid from "@material-ui/core/Grid";
import MenuItem from "@material-ui/core/MenuItem";
import TextField from "@material-ui/core/TextField";
import Typography from "@material-ui/core/Typography";
import I18n from "@iobroker/adapter-react/i18n";

const NAMESPACE = "iobapp.0";

const styles = theme => ({
	root: {
		padding: theme.spacing(3),
		minHeight: "100vh",
		background: theme.palette.type === "dark" ? "#121212" : "#f5f7fb",
	},
	header: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		marginBottom: theme.spacing(3),
		gap: theme.spacing(2),
	},
	card: {
		height: "100%",
	},
	cardTitle: {
		display: "flex",
		alignItems: "center",
		justifyContent: "space-between",
		gap: theme.spacing(1),
		marginBottom: theme.spacing(1),
	},
	metric: {
		fontSize: 34,
		fontWeight: 700,
	},
	listItem: {
		padding: theme.spacing(1.5, 0),
		borderBottom: `1px solid ${theme.palette.divider}`,
		"&:last-child": {
			borderBottom: 0,
		},
	},
	selectableItem: {
		cursor: "pointer",
		borderRadius: theme.shape.borderRadius,
		padding: theme.spacing(1.5),
		margin: theme.spacing(0.5, -1.5),
		"&:hover": {
			background: theme.palette.action.hover,
		},
	},
	selectedItem: {
		background: theme.palette.action.selected,
	},
	secondary: {
		color: theme.palette.text.secondary,
		wordBreak: "break-word",
	},
	chip: {
		marginLeft: theme.spacing(1),
	},
	controlRow: {
		display: "grid",
		gridTemplateColumns: "minmax(180px, 1fr) 180px 180px auto",
		gap: theme.spacing(1),
		alignItems: "center",
		marginTop: theme.spacing(1),
		[theme.breakpoints.down("sm")]: {
			gridTemplateColumns: "1fr",
		},
	},
	formRow: {
		display: "flex",
		gap: theme.spacing(1),
		alignItems: "center",
		marginTop: theme.spacing(2),
		[theme.breakpoints.down("sm")]: {
			flexDirection: "column",
			alignItems: "stretch",
		},
	},
	mono: {
		fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
		fontSize: 12,
	},
	fingerprintBeacon: {
		display: "grid",
		gridTemplateColumns: "1fr auto",
		gap: theme.spacing(1),
		alignItems: "center",
		padding: theme.spacing(1, 0),
		borderBottom: `1px solid ${theme.palette.divider}`,
		"&:last-child": {
			borderBottom: 0,
		},
	},
});

class AdminTab extends React.Component {
	constructor(props) {
		super(props);
		this.state = {
			loading: false,
			saving: false,
			error: "",
			beacons: [],
			areas: [],
			devices: [],
			lastRefresh: null,
			selectedAreaId: "",
			newAreaName: "",
		};
	}

	componentDidMount() {
		this.refresh();
	}

	value(states, id, fallback = "") {
		return states[id] && states[id].val !== undefined && states[id].val !== null ? states[id].val : fallback;
	}

	normalizeObjectSegment(value, fallback = "area") {
		const normalized = String(value || "")
			.trim()
			.toLowerCase()
			.normalize("NFKD")
			.replace(/[\u0300-\u036f]/g, "")
			.replace(/[^a-z0-9_-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.replace(/-{2,}/g, "-");
		return normalized || fallback;
	}

	parseFingerprint(raw) {
		try {
			const parsed = raw ? JSON.parse(raw) : {};
			return {
				...parsed,
				beacons: Array.isArray(parsed.beacons) ? parsed.beacons : [],
			};
		} catch {
			return { beacons: [] };
		}
	}

	refresh = async () => {
		const { socket } = this.props;
		if (!socket) return;

		this.setState({ loading: true, error: "" });
		try {
			const [objects, states] = await Promise.all([
				socket.getObjects(true, true),
				socket.getStates(true),
			]);
			const beacons = this.collectBeacons(objects, states);
			const areas = this.collectAreas(objects, states);
			const selectedAreaId = areas.some(area => area.id === this.state.selectedAreaId)
				? this.state.selectedAreaId
				: (areas[0] && areas[0].id) || "";
			this.setState({
				loading: false,
				beacons,
				areas,
				devices: this.collectDevices(states),
				selectedAreaId,
				lastRefresh: new Date(),
			});
		} catch (error) {
			this.setState({
				loading: false,
				error: error && error.message ? error.message : String(error),
			});
		}
	};

	collectBeacons(objects, states) {
		return Object.keys(objects || {})
			.filter(id => id.startsWith(`${NAMESPACE}.indoor.beacons.`) && objects[id].type === "channel")
			.map(id => {
				const base = id;
				const beaconId = id.replace(`${NAMESPACE}.indoor.beacons.`, "");
				const name = this.value(states, `${base}.display_name`, "")
					|| this.value(states, `${base}.name`, "")
					|| this.value(states, `${base}.local_name`, "")
					|| (objects[id].common && objects[id].common.name)
					|| beaconId;
				return {
					id: beaconId,
					name,
					rawName: this.value(states, `${base}.name`, ""),
					localName: this.value(states, `${base}.local_name`, ""),
					rssi: this.value(states, `${base}.last_rssi`, "—"),
					lastSeen: this.value(states, `${base}.last_seen`, "—"),
					services: this.value(states, `${base}.services`, "[]"),
					classification: this.value(states, `${base}.classification`, "unknown") || "unknown",
					assignedArea: this.value(states, `${base}.assigned_area`, ""),
					notes: this.value(states, `${base}.notes`, ""),
				};
			})
			.sort((left, right) => Number(right.rssi) - Number(left.rssi));
	}

	collectAreas(objects, states) {
		return Object.keys(objects || {})
			.filter(id => id.startsWith(`${NAMESPACE}.indoor.areas.`) && objects[id].type === "channel")
			.map(id => {
				const base = id;
				const fingerprintRaw = this.value(states, `${base}.fingerprint_json`, "{}");
				const fingerprint = this.parseFingerprint(fingerprintRaw);
				return {
					id: id.replace(`${NAMESPACE}.indoor.areas.`, ""),
					name: this.value(states, `${base}.name`, objects[id].common && objects[id].common.name || ""),
					lastLearning: this.value(states, `${base}.last_learning`, "—"),
					sampleCount: this.value(states, `${base}.sample_count`, 0),
					beaconCount: fingerprint.beacons.length,
					fingerprint,
				};
			})
			.sort((left, right) => String(left.name).localeCompare(String(right.name), "de"));
	}

	collectDevices(states) {
		return Object.keys(states || {})
			.filter(id => id.startsWith(`${NAMESPACE}.person.`) && id.endsWith(".indoor.current_area"))
			.map(id => {
				const base = id.replace(".current_area", "");
				const parts = base.split(".");
				return {
					id: base,
					person: parts[3] || "",
					device: parts[4] || "",
					currentArea: this.value(states, `${base}.current_area`, "—"),
					confidence: this.value(states, `${base}.confidence`, 0),
					lastScan: this.value(states, `${base}.last_scan`, "—"),
					trigger: this.value(states, `${base}.last_scan_trigger`, "—"),
					beaconCount: this.value(states, `${base}.beacon_count`, 0),
				};
			})
			.sort((left, right) => `${left.person}.${left.device}`.localeCompare(`${right.person}.${right.device}`));
	}

	createArea = async () => {
		const { socket } = this.props;
		const name = this.state.newAreaName.trim();
		if (!socket || !name) return;
		const areaId = this.normalizeObjectSegment(name);
		const base = `${NAMESPACE}.indoor.areas.${areaId}`;
		const fingerprint = {
			areaId,
			areaName: name,
			updatedAt: "",
			beacons: [],
		};

		this.setState({ saving: true, error: "" });
		try {
			await socket.setObject(base, { type: "channel", common: { name }, native: {} });
			await socket.setObject(`${base}.name`, { type: "state", common: { name: "Area name", type: "string", role: "text", read: true, write: true }, native: {} });
			await socket.setObject(`${base}.last_learning`, { type: "state", common: { name: "Last learning", type: "string", role: "date", read: true, write: true }, native: {} });
			await socket.setObject(`${base}.sample_count`, { type: "state", common: { name: "Sample count", type: "number", role: "value", read: true, write: true }, native: {} });
			await socket.setObject(`${base}.fingerprint_json`, { type: "state", common: { name: "Fingerprint JSON", type: "string", role: "json", read: true, write: true }, native: {} });
			await socket.setState(`${base}.name`, name);
			await socket.setState(`${base}.last_learning`, "");
			await socket.setState(`${base}.sample_count`, 0);
			await socket.setState(`${base}.fingerprint_json`, JSON.stringify(fingerprint));
			this.setState({ newAreaName: "", selectedAreaId: areaId });
			await this.refresh();
		} catch (error) {
			this.setState({ error: error && error.message ? error.message : String(error) });
		} finally {
			this.setState({ saving: false });
		}
	};

	updateBeaconState = async (beaconId, field, value) => {
		const { socket } = this.props;
		if (!socket) return;
		const current = this.state.beacons.find(beacon => beacon.id === beaconId);
		if (current) {
			const currentValue = field === "display_name"
				? current.name
				: field === "classification"
					? current.classification
					: field === "assigned_area"
						? current.assignedArea
						: "";
			if (String(currentValue || "") === String(value || "")) return;
		}
		this.setState({ saving: true, error: "" });
		try {
			await socket.setState(`${NAMESPACE}.indoor.beacons.${beaconId}.${field}`, value);
			await this.refresh();
		} catch (error) {
			this.setState({ error: error && error.message ? error.message : String(error) });
		} finally {
			this.setState({ saving: false });
		}
	};

	removeBeaconFromArea = async (area, beaconId) => {
		const { socket } = this.props;
		if (!socket || !area) return;
		const fingerprint = {
			...area.fingerprint,
			beacons: area.fingerprint.beacons.filter(beacon => beacon.id !== beaconId),
			updatedAt: new Date().toISOString(),
		};
		const base = `${NAMESPACE}.indoor.areas.${area.id}`;
		this.setState({ saving: true, error: "" });
		try {
			await socket.setState(`${base}.fingerprint_json`, JSON.stringify(fingerprint));
			await socket.setState(`${base}.sample_count`, fingerprint.beacons.length);
			await this.refresh();
		} catch (error) {
			this.setState({ error: error && error.message ? error.message : String(error) });
		} finally {
			this.setState({ saving: false });
		}
	};

	renderSummaryCard(title, value, helper) {
		const { classes } = this.props;
		return (
			<Card className={classes.card}>
				<CardContent>
					<Typography color="textSecondary" gutterBottom>{title}</Typography>
					<Typography className={classes.metric}>{value}</Typography>
					<Typography variant="body2" className={classes.secondary}>{helper}</Typography>
				</CardContent>
			</Card>
		);
	}

	renderAreaList(areas) {
		const { classes } = this.props;
		return (
			<Card className={classes.card}>
				<CardContent>
					<Typography variant="h6">{I18n.t("indoorAreas")}</Typography>
					<div className={classes.formRow}>
						<TextField
							label={I18n.t("newIndoorArea")}
							value={this.state.newAreaName}
							onChange={event => this.setState({ newAreaName: event.target.value })}
							fullWidth
						/>
						<Button variant="contained" color="primary" disabled={this.state.saving || !this.state.newAreaName.trim()} onClick={this.createArea}>
							{I18n.t("create")}
						</Button>
					</div>
					{areas.length === 0 ? <Typography className={classes.secondary}>{I18n.t("noIndoorAreas")}</Typography> : areas.map(area => (
						<div
							key={area.id}
							className={`${classes.listItem} ${classes.selectableItem} ${area.id === this.state.selectedAreaId ? classes.selectedItem : ""}`}
							onClick={() => this.setState({ selectedAreaId: area.id })}
						>
							<Typography variant="subtitle1">{area.name || area.id}</Typography>
							<Typography className={classes.secondary}>{area.id}</Typography>
							<Typography variant="caption" className={classes.secondary}>
								{area.beaconCount} Fingerprint-Beacons · {area.sampleCount} Samples · {area.lastLearning}
							</Typography>
						</div>
					))}
				</CardContent>
			</Card>
		);
	}

	renderAreaDetails(area, beaconById) {
		const { classes } = this.props;
		return (
			<Card className={classes.card}>
				<CardContent>
					<Typography variant="h6">{I18n.t("indoorAreaDetails")}</Typography>
					{!area ? (
						<Typography className={classes.secondary}>{I18n.t("selectIndoorArea")}</Typography>
					) : (
						<>
							<Typography variant="subtitle1">{area.name || area.id}</Typography>
							<Typography className={classes.secondary}>{area.id}</Typography>
							{area.fingerprint.beacons.length === 0 ? (
								<Typography className={classes.secondary}>{I18n.t("emptyFingerprint")}</Typography>
							) : area.fingerprint.beacons.map(beacon => {
								const knownBeacon = beaconById.get(beacon.id);
								return (
									<div key={beacon.id} className={classes.fingerprintBeacon}>
										<div>
											<Typography variant="subtitle2">
												{knownBeacon ? knownBeacon.name : beacon.name || beacon.id}
												{knownBeacon ? <Chip size="small" className={classes.chip} label={knownBeacon.classification} /> : null}
											</Typography>
											<Typography className={`${classes.secondary} ${classes.mono}`}>{beacon.id}</Typography>
											<Typography variant="caption" className={classes.secondary}>
												RSSI Ø {beacon.averageRssi} · Max {beacon.maxRssi} · Samples {beacon.count || 1}
											</Typography>
										</div>
										<Button size="small" disabled={this.state.saving} onClick={() => this.removeBeaconFromArea(area, beacon.id)}>
											{I18n.t("remove")}
										</Button>
									</div>
								);
							})}
						</>
					)}
				</CardContent>
			</Card>
		);
	}

	renderBeaconManager(beacons, areas) {
		const { classes } = this.props;
		return (
			<Card>
				<CardContent>
					<div className={classes.cardTitle}>
						<Typography variant="h6">{I18n.t("indoorBeacons")}</Typography>
						<Typography variant="body2" className={classes.secondary}>{I18n.t("indoorBeaconManagementHint")}</Typography>
					</div>
					{beacons.length === 0 ? <Typography className={classes.secondary}>{I18n.t("noIndoorBeacons")}</Typography> : beacons.map(beacon => (
						<div key={beacon.id} className={classes.listItem}>
							<Typography variant="subtitle1">{beacon.name}</Typography>
							<Typography className={`${classes.secondary} ${classes.mono}`}>{beacon.id}</Typography>
							<Typography variant="caption" className={classes.secondary}>
								RSSI {beacon.rssi} · {beacon.lastSeen}
							</Typography>
							<div className={classes.controlRow}>
								<TextField
									label={I18n.t("displayName")}
									defaultValue={beacon.name}
									onBlur={event => this.updateBeaconState(beacon.id, "display_name", event.target.value)}
									disabled={this.state.saving}
								/>
								<TextField
									select
									label={I18n.t("classification")}
									value={beacon.classification}
									onChange={event => this.updateBeaconState(beacon.id, "classification", event.target.value)}
									disabled={this.state.saving}
								>
									<MenuItem value="unknown">{I18n.t("beaconUnknown")}</MenuItem>
									<MenuItem value="fixed">{I18n.t("beaconFixed")}</MenuItem>
									<MenuItem value="mobile">{I18n.t("beaconMobile")}</MenuItem>
									<MenuItem value="ignored">{I18n.t("beaconIgnored")}</MenuItem>
								</TextField>
								<TextField
									select
									label={I18n.t("assignedArea")}
									value={beacon.assignedArea}
									onChange={event => this.updateBeaconState(beacon.id, "assigned_area", event.target.value)}
									disabled={this.state.saving}
								>
									<MenuItem value="">{I18n.t("none")}</MenuItem>
									{areas.map(area => <MenuItem key={area.id} value={area.id}>{area.name || area.id}</MenuItem>)}
								</TextField>
								<Button size="small" disabled={this.state.saving} onClick={() => this.updateBeaconState(beacon.id, "classification", "ignored")}>
									{I18n.t("ignore")}
								</Button>
							</div>
						</div>
					))}
				</CardContent>
			</Card>
		);
	}

	render() {
		const { classes } = this.props;
		const { loading, error, beacons, areas, devices, lastRefresh } = this.state;
		const selectedArea = areas.find(area => area.id === this.state.selectedAreaId);
		const beaconById = new Map(beacons.map(beacon => [beacon.id, beacon]));

		return (
			<div className={classes.root}>
				<div className={classes.header}>
					<div>
						<Typography variant="h4">{I18n.t("indoorDashboard")}</Typography>
						<Typography variant="body2" className={classes.secondary}>
							{I18n.t("indoorDashboardHint")}
						</Typography>
					</div>
					<Button variant="contained" color="primary" onClick={this.refresh} disabled={loading}>
						{I18n.t("refresh")}
					</Button>
				</div>

				{error ? <Typography color="error">{error}</Typography> : null}

				<Grid container spacing={2}>
					<Grid item xs={12} md={4}>{this.renderSummaryCard(I18n.t("indoorAreas"), areas.length, I18n.t("indoorAreasHint"))}</Grid>
					<Grid item xs={12} md={4}>{this.renderSummaryCard(I18n.t("indoorBeacons"), beacons.length, I18n.t("indoorBeaconsHint"))}</Grid>
					<Grid item xs={12} md={4}>{this.renderSummaryCard(I18n.t("indoorDevices"), devices.length, lastRefresh ? lastRefresh.toLocaleTimeString() : "—")}</Grid>

					<Grid item xs={12} lg={4}>
						<Card className={classes.card}>
							<CardContent>
								<Typography variant="h6">{I18n.t("indoorDevices")}</Typography>
								{devices.length === 0 ? <Typography className={classes.secondary}>{I18n.t("noIndoorDevices")}</Typography> : devices.map(device => (
									<div key={device.id} className={classes.listItem}>
										<Typography variant="subtitle1">{device.person} · {device.device}</Typography>
										<Typography className={classes.secondary}>
											{I18n.t("currentArea")}: {device.currentArea || "—"}
											<Chip size="small" className={classes.chip} label={`${Math.round(Number(device.confidence) * 100)}%`} />
										</Typography>
										<Typography variant="caption" className={classes.secondary}>
											{device.lastScan} · {device.trigger} · {device.beaconCount} Beacons
										</Typography>
									</div>
								))}
							</CardContent>
						</Card>
					</Grid>
					<Grid item xs={12} lg={4}>{this.renderAreaList(areas)}</Grid>
					<Grid item xs={12} lg={4}>{this.renderAreaDetails(selectedArea, beaconById)}</Grid>
					<Grid item xs={12}>{this.renderBeaconManager(beacons, areas)}</Grid>
				</Grid>
			</div>
		);
	}
}

export default withStyles(styles)(AdminTab);
