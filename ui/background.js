define(function(require) {
	var modelController = require('../lib/controllers/model');
	var devtoolsController = require('../lib/controllers/devtools');
	var errorStateTracker = require('../lib/controllers/error-tracker');
	var errorLogger = require('../lib/controllers/error-logger');
	var userStylesheets = require('../lib/helpers/user-stylesheets');
	var browserActionIcon = require('../lib/browser-action-icon');
	var utils = require('../lib/utils');
	var client = require('../node_modules/livestyle-client/index');
	var patcher = require('../node_modules/livestyle-patcher/index');

	var workerCommandQueue = patcher(client, {
		worker: '../out/worker.js'
	});

	function copy(obj) {
		return utils.extend({}, obj);
	}

	function applyDiff(data) {
		modelController.active(function(models) {
			models.forEach(function(item) {
				var uri = data.uri;
				var model = item.model;
				var assocs = model.associations();
				var user = model.get('userStylesheets');
				var userTransposed = {};
				Object.keys(user).forEach(function(key) {
					userTransposed[user[key]] = key;
				});

				if (userTransposed[uri]) {
					uri = userTransposed[uri];
				}

				if (uri in assocs) {
					// This diff result is for browser file, meaning that browser
					// file was updated and editor should receive these changes
					return client.send('incoming-updates', {
						uri: assocs[uri],
						patches: data.patches
					});
				}

				// Looks like this diff result is coming from editor file:
				// find corresponding browser file and patch it
				var stylesheetUrl = null;
				Object.keys(assocs).some(function(key) {
					if (assocs[key] === uri) {
						return stylesheetUrl = key;
					}
				});

				if (stylesheetUrl in user) {
					stylesheetUrl = user[stylesheetUrl];
				}

				if (stylesheetUrl) {
					console.log('apply diff on', stylesheetUrl, data.patches);
					chrome.tabs.sendMessage(item.tab.id, {
						name: 'apply-cssom-patch',
						data: {
							stylesheetUrl: stylesheetUrl,
							patches: data.patches
						}
					});
					devtoolsController.saveDiff(item.tab.id, stylesheetUrl, data.patches);
				}
			});
		});
	}

	function setCurrentIconState() {
		console.log('update current state');
		modelController.current(function(model) {
			browserActionIcon.state(model.get('enabled') ? 'active' : 'disabled');
		});
	}

	self.LiveStyle = {
		/**
		 * Returns model for currently opened page
		 */
		getCurrentModel: function(callback) {
			modelController.current(callback);
		},

		hasErrors: function() {
			return !!errorLogger.getLog().length;
		},

		log: function(message) {
			console.log('%c[Content]', 'background:#e67e22;color:#fff', message);
		},

		errorStateTracker: errorStateTracker.watch(workerCommandQueue),
		updateIconState: setCurrentIconState
	};

	errorLogger.watch(workerCommandQueue);

	chrome.runtime.onMessage.addListener(function(message) {
		switch (message.name) {
			case 'add-user-stylesheet':
				modelController.current(function(model, tab) {
					var stylesheets = copy(model.get('userStylesheets'));
					var maxId = 0;
					Object.keys(stylesheets).forEach(function(url) {
						var id = userStylesheets.is(url);
						if (id && +id > maxId) {
							maxId = +id;
						}
					});

					var newStylesheet = 'livestyle:' + (maxId + 1);
					console.log('Add user stylesheet %c%s', 'font-weight:bold', newStylesheet);
					userStylesheets.create(tab.id, newStylesheet, function(data) {
						stylesheets[newStylesheet] = data[newStylesheet] || '';
						model.set('userStylesheets', stylesheets);
					});
				});
				break;

			case 'remove-user-stylesheet':
				var url = message.data.url;
				console.log('Remove user stylesheet %c%s', 'font-weight:bold', url);
				modelController.current(function(model, tab) {
					var stylesheets = copy(model.get('userStylesheets'));
					var assocs = copy(model.get('assocs'));
					delete stylesheets[url];
					delete assocs[url];

					model.set({
						userStylesheets: stylesheets,
						assocs: assocs
					});
					userStylesheets.remove(tab.id, url);
				});
				break;
		}
	});

	// setup browser action icon state update
	chrome.tabs.onHighlighted.addListener(setCurrentIconState);
	setCurrentIconState();
	errorStateTracker.on('change:error', function() {
		var err = this.get('error');
		console.log('error state changed', err);
		if (err) {
			browserActionIcon.state('error');
		} else {
			setCurrentIconState();
		}
	});

	workerCommandQueue.worker.addEventListener('message', function(message) {
		var payload = message.data;
		if (payload.name === 'init') {
			return console.log('%c%s', 'color:green;font-size:1.1em;font-weight:bold;', payload.data);
		}
	});

	client
	.on('message-send', function(name, data) {
		console.log('send socket message %c%s', 'font-weight:bold', name);
		if (name === 'diff') {
			// sending `diff` message from worker: 
			// server won’t send it back to sender so handle it manually
			applyDiff(data);
		}
	})
	.on('diff', function(data) {
		applyDiff(data);
	})
	.connect();
});