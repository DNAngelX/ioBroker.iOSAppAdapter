import React from "react";
import { withStyles } from "@material-ui/core/styles";
import Button from "@material-ui/core/Button";
import Card from "@material-ui/core/Card";
import CardContent from "@material-ui/core/CardContent";
import Chip from "@material-ui/core/Chip";
import Grid from "@material-ui/core/Grid";
import Typography from "@material-ui/core/Typography";
import I18n from "@iobroker/adapter-react/i18n";

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
	secondary: {
		color: theme.palette.text.secondary,
		wordBreak: "break-word",
	},
	chip: {
		marginLeft: theme.spacing(1),
	},
});

class AdminTab extends React.Component {
	constructor(props) {
		super(props);
		this.state = {
			loading: false,
			error: "",
			beacons: [],
			areas: [],
			devices: [],
			lastRefresh: null,
		};
	}

	componentDidMount() {
		this.refresh();
	}

	value(states, id, fallback = "") {
		return states[id] && states[id].val !== undefined && states[id].val !== null ? states[id].val : fallback;
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
			this.setState({
				loading: false,
				beacons: this.collectBeacons(objects, states),
				areas: this.collectAreas(objects, states),
				devices: this.collectDevices(states),
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
			.filter(id => id.startsWith("iobapp.0.indoor.beacons.") && objects[id].type === "channel")
			.map(id => {
				const base = id;
				return {
					id: id.replace("iobapp.0.indoor.beacons.", ""),
					name: this.value(states, `${base}.name`, objects[id].common && objects[id].common.name || ""),
					localName: this.value(states, `${base}.local_name`, ""),
					rssi: this.value(states, `${base}.last_rssi`, "—"),
					lastSeen: this.value(states, `${base}.last_seen`, "—"),
					services: this.value(states, `${base}.services`, "[]"),
				};
			})
			.sort((left, right) => Number(right.rssi) - Number(left.rssi));
	}

	collectAreas(objects, states) {
		return Object.keys(objects || {})
			.filter(id => id.startsWith("iobapp.0.indoor.areas.") && objects[id].type === "channel")
			.map(id => {
				const base = id;
				const fingerprint = this.value(states, `${base}.fingerprint_json`, "{}");
				let beaconCount = 0;
				try {
					beaconCount = JSON.parse(fingerprint).beacons?.length || 0;
				} catch {
					beaconCount = 0;
				}
				return {
					id: id.replace("iobapp.0.indoor.areas.", ""),
					name: this.value(states, `${base}.name`, objects[id].common && objects[id].common.name || ""),
					lastLearning: this.value(states, `${base}.last_learning`, "—"),
					sampleCount: this.value(states, `${base}.sample_count`, 0),
					beaconCount,
				};
			})
			.sort((left, right) => String(left.name).localeCompare(String(right.name), "de"));
	}

	collectDevices(states) {
		return Object.keys(states || {})
			.filter(id => id.startsWith("iobapp.0.person.") && id.endsWith(".indoor.current_area"))
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

	render() {
		const { classes } = this.props;
		const { loading, error, beacons, areas, devices, lastRefresh } = this.state;

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
								<div className={classes.cardTitle}>
									<Typography variant="h6">{I18n.t("indoorDevices")}</Typography>
								</div>
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

					<Grid item xs={12} lg={4}>
						<Card className={classes.card}>
							<CardContent>
								<Typography variant="h6">{I18n.t("indoorAreas")}</Typography>
								{areas.length === 0 ? <Typography className={classes.secondary}>{I18n.t("noIndoorAreas")}</Typography> : areas.map(area => (
									<div key={area.id} className={classes.listItem}>
										<Typography variant="subtitle1">{area.name || area.id}</Typography>
										<Typography className={classes.secondary}>{area.id}</Typography>
										<Typography variant="caption" className={classes.secondary}>
											{area.beaconCount} Fingerprint-Beacons · {area.sampleCount} Samples · {area.lastLearning}
										</Typography>
									</div>
								))}
							</CardContent>
						</Card>
					</Grid>

					<Grid item xs={12} lg={4}>
						<Card className={classes.card}>
							<CardContent>
								<Typography variant="h6">{I18n.t("indoorBeacons")}</Typography>
								{beacons.length === 0 ? <Typography className={classes.secondary}>{I18n.t("noIndoorBeacons")}</Typography> : beacons.slice(0, 30).map(beacon => (
									<div key={beacon.id} className={classes.listItem}>
										<Typography variant="subtitle1">{beacon.name || beacon.localName || beacon.id}</Typography>
										<Typography className={classes.secondary}>{beacon.id}</Typography>
										<Typography variant="caption" className={classes.secondary}>
											RSSI {beacon.rssi} · {beacon.lastSeen}
										</Typography>
									</div>
								))}
							</CardContent>
						</Card>
					</Grid>
				</Grid>
			</div>
		);
	}
}

export default withStyles(styles)(AdminTab);
