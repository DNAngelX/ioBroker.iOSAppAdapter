import React from "react";
import { withStyles } from "@material-ui/core/styles";
import TextField from "@material-ui/core/TextField";
import Input from "@material-ui/core/Input";
import FormHelperText from "@material-ui/core/FormHelperText";
import FormControl from "@material-ui/core/FormControl";
import Select from "@material-ui/core/Select";
import MenuItem from "@material-ui/core/MenuItem";
import Button from "@material-ui/core/Button";
import FormControlLabel from "@material-ui/core/FormControlLabel";
import Checkbox from "@material-ui/core/Checkbox";
import Typography from "@material-ui/core/Typography";
import I18n from "@iobroker/adapter-react/i18n";

/**
 * @type {() => Record<string, import("@material-ui/core/styles/withStyles").CreateCSSProperties>}
 */
const styles = theme => ({
	tab: {
		boxSizing: "border-box",
		height: "calc(100vh - 86px)",
		overflowY: "auto",
		padding: theme.spacing(2, 3, 14, 3),
		maxWidth: 760,
		color: theme.palette.text.primary,
	},
	input: {
		marginTop: 0,
		width: "100%",
		maxWidth: 640,
	},
	button: {
		marginRight: 20,
	},
	card: {
		maxWidth: 345,
		textAlign: "center",
	},
	media: {
		height: 180,
	},
	column: {
		display: "inline-block",
		verticalAlign: "top",
		marginRight: 20,
	},
	columnLogo: {
		width: 350,
		marginRight: 0,
	},
	columnSettings: {
		width: "calc(100% - 370px)",
	},
	controlElement: {
		//background: "#d2d2d2",
		marginBottom: 5,
		color: theme.palette.text.primary,
	},
	sectionTitle: {
		marginTop: theme.spacing(4),
		color: theme.palette.text.primary,
	},
	sectionHint: {
		marginBottom: theme.spacing(1),
		maxWidth: 980,
	},
});

/**
 * @typedef {object} SettingsProps
 * @property {Record<string, string>} classes
 * @property {Record<string, any>} native
 * @property {(attr: string, value: any) => void} onChange
 */

/**
 * @typedef {object} SettingsState
 * @property {undefined} [dummy] Delete this and add your own state properties here
 */

/**
 * @extends {React.Component<SettingsProps, SettingsState>}
 */
class Settings extends React.Component {
	constructor(props) {
		super(props);
		this.state = {};
	}

	/**
	 * @param {AdminWord} title
	 * @param {string} attr
	 * @param {string} type
	 */
	renderInput(title, attr, type) {
		return (
			<TextField
				label={I18n.t(title)}
				className={`${this.props.classes.input} ${this.props.classes.controlElement}`}
				value={this.props.native[attr]}
				type={type || "text"}
				onChange={(e) => this.props.onChange(attr, e.target.value)}
				margin="normal"
			/>
		);
	}

	/**
	 * @param {AdminWord} title
	 * @param {string} attr
	 * @param {{ value: string; title: AdminWord }[]} options
	 * @param {React.CSSProperties} [style]
	 */
	renderSelect(title, attr, options, style) {
		return (
			<FormControl
				className={`${this.props.classes.input} ${this.props.classes.controlElement}`}
				style={{
					paddingTop: 5,
					...style
				}}
			>
				<Select
					value={this.props.native[attr] || "_"}
					onChange={(e) => this.props.onChange(attr, e.target.value === "_" ? "" : e.target.value)}
					input={<Input name={attr} id={attr + "-helper"} />}
				>
					{options.map((item) => (
						<MenuItem key={"key-" + item.value} value={item.value || "_"}>
							{I18n.t(item.title)}
						</MenuItem>
					))}
				</Select>
				<FormHelperText>{I18n.t(title)}</FormHelperText>
			</FormControl>
		);
	}

	/**
	 * @param {AdminWord} title
	 * @param {string} attr
	 * @param {React.CSSProperties} [style]
	 */
	renderCheckbox(title, attr, style) {
		return (
			<FormControlLabel
				key={attr}
				style={{
					paddingTop: 5,
					...style
				}}
				className={this.props.classes.controlElement}
				control={
					<Checkbox
						checked={this.props.native[attr]}
						onChange={() => this.props.onChange(attr, !this.props.native[attr])}
						color="primary"
					/>
				}
				label={I18n.t(title)}
			/>
		);
	}

	openIndoorDashboard = () => {
		const pathname = window.location.pathname.replace(/index_m\.html$/, "tab_m.html");
		window.location.href = `${pathname}${window.location.search || ""}`;
	};

	render() {
		return (
			<form className={this.props.classes.tab}>
				{this.renderInput("username", "username", "text")}
				<br />
				{this.renderInput("password", "password", "password")}
				<br />
				{this.renderInput("wsPort", "wsPort", "number")}
				<br />
				{this.renderCheckbox("relayEnabled", "relayEnabled")}
				<br />
				{this.renderInput("relayUrl", "relayUrl", "text")}
				<br />
				{this.renderInput("relayApiKey", "relayApiKey", "password")}
				<br />
				{this.renderInput("wakeAfterMinutes", "wakeAfterMinutes", "number")}
				<br />
				{this.renderInput("minWakeIntervalMinutes", "minWakeIntervalMinutes", "number")}
				<br />
				<Typography variant="h6" className={this.props.classes.sectionTitle}>
					{I18n.t("indoorPositioning")}
				</Typography>
				<Typography variant="body2" color="textSecondary" className={this.props.classes.sectionHint}>
					{I18n.t("indoorPositioningHint")}
				</Typography>
				{this.renderCheckbox("indoorEnabled", "indoorEnabled")}
				<br />
				{this.renderInput("indoorScanSeconds", "indoorScanSeconds", "number")}
				<br />
				{this.renderInput("indoorLearningSeconds", "indoorLearningSeconds", "number")}
				<br />
				{this.renderInput("indoorMinimumConfidence", "indoorMinimumConfidence", "number")}
				<br />
				<Button variant="contained" color="primary" onClick={this.openIndoorDashboard}>
					{I18n.t("openIndoorDashboard")}
				</Button>
			</form>
		);
	}
}

export default withStyles(styles)(Settings);
