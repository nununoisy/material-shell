const { St, Meta, GLib, Clutter, GObject, Gio } = imports.gi;
const Main = imports.ui.main;
const Me = imports.misc.extensionUtils.getCurrentExtension();
const { AppPlaceholder } = Me.imports.src.widget.appPlaceholder;
const WindowUtils = Me.imports.src.utils.windows;
const { AddLogToFunctions, log, logFocus } = Me.imports.src.utils.debug;
/* exported MsWindow */

var MsWindow = GObject.registerClass(
    {
        GTypeName: 'MsWindow',
        Signals: {
            title_changed: {
                param_types: [GObject.TYPE_STRING],
            },
            dragged_changed: {
                param_types: [GObject.TYPE_BOOLEAN],
            },
            request_new_meta_window: {},
        },
    },
    class MsWindow extends Clutter.Actor {
        _init(app, metaWindowIdentifier, metaWindow, persistent) {
            AddLogToFunctions(this);
            super._init({
                reactive: true,
            });

            this.destroyId = this.connect(
                'destroy',
                this._onDestroy.bind(this)
            );
            this.connect('parent-set', () => {
                this.msContent.style_changed();
                this.updateMetaWindowVisibility();
            });
            this.connect('notify::visible', () => {
                this.updateMetaWindowVisibility();
            });

            this.app = app;
            this._persistent = persistent;
            logFocus('_persistent', this._persistent);
            this.dialogs = [];
            this.metaWindowIdentifier = metaWindowIdentifier;
            this.windowClone = new Clutter.Clone();
            this.placeholder = new AppPlaceholder(this.app);
            logFocus('after placeholder creation');
            this.placeholder.connect('clicked', (_) => {
                this.emit('request-new-meta-window');
            });
            this.metaWindowSignals = [];
            this.msContent = new MsWindowContent(
                this.placeholder,
                this.windowClone
            );
            this.add_child(this.msContent);
            if (metaWindow) {
                this.setWindow(metaWindow);
            }
        }

        get metaWindow() {
            return (
                this._metaWindow ||
                (this.dialogs &&
                    this.dialogs[this.dialogs.length - 1] &&
                    this.dialogs[this.dialogs.length - 1].metaWindow)
            );
        }

        get title() {
            if (!this.app) return '';
            return this.metaWindow
                ? this.metaWindow.get_title()
                : this.app.get_name();
        }

        set persistent(boolean) {
            this._persistent = boolean;
            Me.msWorkspaceManager.stateChanged();
        }

        delayGetMetaWindowActor(metaWindow, delayedCount, resolve, reject) {
            log('delay actor !', delayedCount);

            if (delayedCount < 20) {
                // If we don't have actor we hope to get it in the next loop
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
                    let actor = metaWindow.get_compositor_private();
                    if (actor && actor.get_texture()) {
                        resolve(actor);
                    } else {
                        this.delayGetMetaWindowActor(
                            metaWindow,
                            delayedCount++,
                            resolve,
                            reject
                        );
                    }
                    return GLib.SOURCE_REMOVE;
                });
            } else {
                reject();
            }
        }

        get dragged() {
            return Me.msWindowManager.msDndManager.msWindowDragged === this;
        }

        get followMetaWindow() {
            if (!this.msWorkspace) return false;
            return (
                (this.msWorkspace &&
                    this.msWorkspace.tilingLayout.constructor.key ===
                        'float') ||
                (this.metaWindow && this.metaWindow.fullscreen)
            );
        }

        async onMetaWindowActorExist(metaWindow) {
            return new Promise((resolve, reject) => {
                if (!metaWindow) {
                    return resolve();
                }
                let actor = metaWindow.get_compositor_private();
                if (actor && actor.get_texture()) {
                    resolve(actor);
                } else {
                    this.delayGetMetaWindowActor(
                        metaWindow,
                        0,
                        resolve,
                        reject
                    );
                }
            });
        }

        async onMetaWindowFirstFrameDrawn() {
            return new Promise((resolve) => {
                if (!this.metaWindow) {
                    return resolve();
                }
                if (this.metaWindow.firstFrameDrawn) {
                    resolve();
                } else {
                    this.metaWindow
                        .get_compositor_private()
                        .connect('first-frame', () => {
                            resolve();
                        });
                }
            });
        }

        vfunc_allocate(box, flags) {
            log(
                'allocate msWindow',
                this.title,
                box.x1,
                box.y1,
                box.get_width(),
                box.get_height()
            );
            box.x1 = Math.round(box.x1);
            box.y1 = Math.round(box.y1);
            box.x2 = Math.round(box.x2);
            box.y2 = Math.round(box.y2);
            this.set_allocation(box, flags);
            let contentBox = new Clutter.ActorBox();
            contentBox.x2 = box.get_width();
            contentBox.y2 = box.get_height();
            this.msContent.allocate(contentBox, flags);
            const workArea = Main.layoutManager.getWorkAreaForMonitor(
                this.msWorkspace.monitor.index
            );
            const monitorInFullScreen = global.display.get_monitor_in_fullscreen(
                this.msWorkspace.monitor.index
            );
            let offsetX = monitorInFullScreen
                ? this.msWorkspace.monitor.x
                : workArea.x;
            let offsetY = monitorInFullScreen
                ? this.msWorkspace.monitor.y
                : workArea.y;
            this.dialogs.forEach((dialog) => {
                let dialogBox = new Clutter.ActorBox();
                let dialogFrame = dialog.metaWindow.get_buffer_rect();
                dialogBox.x1 = dialogFrame.x - box.x1 - offsetX;
                dialogBox.x2 = dialogBox.x1 + dialogFrame.width;
                dialogBox.y1 = dialogFrame.y - box.y1 - offsetY;
                dialogBox.y2 = dialogBox.y1 + dialogFrame.height;
                dialog.clone.allocate(dialogBox, flags);
            });
        }

        set_position(x, y) {
            if (this.followMetaWindow) return;
            super.set_position(x, y);
        }

        set_size(width, height) {
            if (this.followMetaWindow) return;
            super.set_size(width, height);
        }

        getRelativeMetaWindowPosition(metaWindow) {
            let x = this.x;
            let y = this.y;

            let currentFrameRect = metaWindow.get_frame_rect();
            const workArea = Main.layoutManager.getWorkAreaForMonitor(
                this.msWorkspace.monitor.index
            );

            return {
                x: this.dragged ? currentFrameRect.x : workArea.x + x,
                y: this.dragged ? currentFrameRect.y : workArea.y + y,
            };
        }

        /*
         * This function is called every time the position or the size of the actor change and is meant to update the metaWindow accordingly
         */
        updateMetaWindowPositionAndSize() {
            if (
                !this._metaWindow ||
                !this._metaWindow.get_compositor_private() ||
                !this.mapped ||
                this.width === 0 ||
                this.height === 0 ||
                !this._metaWindow.firstFrameDrawn ||
                this.followMetaWindow
            ) {
                return;
            }

            const workArea = Main.layoutManager.getWorkAreaForMonitor(
                this.msWorkspace.monitor.index
            );
            let contentBox = this.msContent.allocation;
            let windowActor = this.metaWindow.get_compositor_private();

            //Check if the actor position is corresponding of the maximized state (is equal of the size of the workArea)
            const isMaximized =
                this.x === workArea.x &&
                this.y === workArea.y &&
                this.width === workArea.width &&
                this.height === workArea.height;

            /*  if (isMaximized) {
                if (this.metaWindow.maximized) return;
                return this.metaWindow.maximize(Meta.MaximizeFlags.BOTH);
            }*/
            //Or remove the maximized if it's not
            let currentFrameRect = this.metaWindow.get_frame_rect();

            if (this.metaWindow.maximized_horizontally) {
                windowActor.unmaximizedByMs = true;
                this.metaWindow.unmaximize(Meta.MaximizeFlags.BOTH);
            }
            let moveTo, resizeTo;
            if (this.metaWindow.resizeable) {
                //Set the metaWindow maximized if it's the case
                moveTo = this.getRelativeMetaWindowPosition(this.metaWindow);
                resizeTo = {
                    width: this.width,
                    height: this.height,
                };
            } else {
                let relativePosition = this.getRelativeMetaWindowPosition(
                    this.metaWindow
                );

                moveTo = {
                    x:
                        relativePosition.x +
                        (contentBox.get_width() - currentFrameRect.width) / 2,
                    y:
                        relativePosition.y +
                        (contentBox.get_height() - currentFrameRect.height) / 2,
                };
                resizeTo = {
                    width: currentFrameRect.width,
                    height: currentFrameRect.height,
                };
            }

            if (
                currentFrameRect.x === moveTo.x &&
                currentFrameRect.y === moveTo.y &&
                currentFrameRect.width === resizeTo.width &&
                currentFrameRect.height === resizeTo.height
            ) {
                return;
            }
            // Secure the futur metaWindow Position to ensure it's not outside the current monitor
            if (!this.dragged) {
                moveTo.x = Math.max(
                    Math.min(
                        moveTo.x,
                        this.msWorkspace.monitor.x +
                            this.msWorkspace.monitor.width -
                            resizeTo.width
                    ),
                    this.msWorkspace.monitor.x
                );
                moveTo.y = Math.max(
                    Math.min(
                        moveTo.y,
                        this.msWorkspace.monitor.y +
                            this.msWorkspace.monitor.height -
                            resizeTo.height
                    ),
                    this.msWorkspace.monitor.y
                );
            }
            //Set the size accordingly
            this.metaWindow.move_resize_frame(
                true,
                moveTo.x,
                moveTo.y,
                resizeTo.width,
                resizeTo.height
            );

            /**
             * Hack start to prevent unmaximize crash
             * Check overrideModule.js to know more about this hack
             */
            if (windowActor.completeIsRequested) {
                GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    Main.wm._shellwm.completed_size_change(windowActor);
                    delete windowActor.completeIsRequested;
                    return GLib.SOURCE_REMOVE;
                });
            }
            /**
             * Hack end
             */
        }

        mimicMetaWindowPositionAndSize() {
            if (this.dragged) return;
            const workArea = Main.layoutManager.getWorkAreaForMonitor(
                this.metaWindow.get_monitor()
            );
            const currentFrameRect = this.metaWindow.get_frame_rect();
            let newPosition = {
                x:
                    currentFrameRect.x -
                    (this.metaWindow.fullscreen
                        ? this.msWorkspace.monitor.x
                        : workArea.x) -
                    this.msContent.x,
                y:
                    currentFrameRect.y -
                    (this.metaWindow.fullscreen
                        ? this.msWorkspace.monitor.y
                        : workArea.y) -
                    this.msContent.y,
            };
            let newSize = {
                width: currentFrameRect.width + this.msContent.x * 2,
                height: currentFrameRect.height + this.msContent.y * 2,
            };
            super.set_position(newPosition.x, newPosition.y);
            super.set_size(newSize.width, newSize.height);
        }

        resizeDialogs() {
            this.dialogs.forEach((dialog) => {
                let { metaWindow } = dialog;
                let frame = metaWindow.get_frame_rect();
                const workArea = Main.layoutManager.getWorkAreaForMonitor(
                    this.msWorkspace.monitor.index
                );
                const monitorInFullScreen = global.display.get_monitor_in_fullscreen(
                    this.msWorkspace.monitor.index
                );
                let offsetX = monitorInFullScreen
                    ? this.msWorkspace.monitor.x
                    : workArea.x;
                let offsetY = monitorInFullScreen
                    ? this.msWorkspace.monitor.y
                    : workArea.y;
                if (metaWindow.resizeable) {
                    let minWidth = Math.min(frame.width, this.width);
                    let minHeight = Math.min(frame.height, this.height);

                    metaWindow.move_resize_frame(
                        true,
                        offsetX + this.x + (this.width - minWidth) / 2,
                        offsetY + this.y + (this.height - minHeight) / 2,
                        minWidth,
                        minHeight
                    );
                } else if (metaWindow.allows_move()) {
                    metaWindow.move_frame(
                        true,
                        offsetX + this.x + (this.width - frame.width) / 2,
                        offsetY + this.y + (this.height - frame.height) / 2
                    );
                }
            });
        }

        resizeMetaWindows() {
            if (this._metaWindow) {
                this.followMetaWindow
                    ? this.mimicMetaWindowPositionAndSize()
                    : this.updateMetaWindowPositionAndSize();
            }

            this.resizeDialogs();
        }

        registerOnMetaWindowSignals() {
            if (!this.metaWindow) return;
            this.metaWindowSignals.push(
                this.metaWindow.connect('notify::title', (_) => {
                    this.emit('title-changed', this.title);
                }),
                this.metaWindow.connect('position-changed', () => {
                    if (this.followMetaWindow) {
                        this.mimicMetaWindowPositionAndSize();
                    }
                }),
                this.metaWindow.connect('size-changed', () => {
                    if (this.followMetaWindow) {
                        this.mimicMetaWindowPositionAndSize();
                    }
                }),
                this.metaWindow.connect('notify::fullscreen', () => {
                    if (this.followMetaWindow) {
                        this.mimicMetaWindowPositionAndSize();
                    }
                })
            );
        }

        unregisterOnMetaWindowSignals() {
            if (!this.metaWindow) return;
            this.metaWindowSignals.forEach((signalId) => {
                this.metaWindow.disconnect(signalId);
            });
            this.metaWindowSignals = [];
        }

        setMsWorkspace(msWorkspace) {
            this.msWorkspace = msWorkspace;
            [
                ...this.dialogs.map((dialog) => dialog.metaWindow),
                this.metaWindow,
            ].forEach((metaWindow) => {
                if (metaWindow) {
                    WindowUtils.updateTitleBarVisibility(metaWindow);
                    this.updateWorkspaceAndMonitor(metaWindow);
                }
            });
            this.resizeMetaWindows();
        }

        async setWindow(metaWindow) {
            this._metaWindow = metaWindow;
            metaWindow.msWindow = this;

            this.registerOnMetaWindowSignals();
            this.updateWorkspaceAndMonitor(metaWindow);
            this.windowClone.set_source(metaWindow.get_compositor_private());
            await this.onMetaWindowsChanged();
        }

        unsetWindow() {
            this.unregisterOnMetaWindowSignals();
            this.reactive = true;
            delete this._metaWindow;
            delete this.metaWindowUpdateInProgressPromise;
            this.onMetaWindowsChanged();
        }

        updateWorkspaceAndMonitor(metaWindow) {
            if (metaWindow && this.msWorkspace) {
                // We need to move the window before changing the workspace, because
                // the move itself could cause a workspace change if the window enters
                // the primary monitor
                if (metaWindow.get_monitor() != this.msWorkspace.monitor.index)
                    metaWindow.move_to_monitor(this.msWorkspace.monitor.index);

                let workspace = Me.msWorkspaceManager.getWorkspaceOfMsWorkspace(
                    this.msWorkspace
                );
                if (workspace && metaWindow.get_workspace() != workspace) {
                    metaWindow.change_workspace(workspace);
                }
            }
        }

        addDialog(metaWindow) {
            this.updateWorkspaceAndMonitor(metaWindow);
            let clone = new Clutter.Clone({
                source: metaWindow.get_compositor_private(),
            });

            let dialog = {
                metaWindow,
                clone,
            };
            metaWindow.connect('unmanaged', () => {
                this.dialogs.splice(this.dialogs.indexOf(dialog), 1);
            });
            metaWindow.msWindow = this;
            this.dialogs.push(dialog);
            this.add_child(clone);
            this.resizeDialogs();
            this.onMetaWindowsChanged();
            if (this.msWorkspace.tileableFocused === this) {
                this.takeFocus();
            }
        }

        async onMetaWindowsChanged() {
            if (this.metaWindow) {
                this.metaWindowIdentifier = Me.msWindowManager.buildMetaWindowIdentifier(
                    this.metaWindow
                );
                this.reactive = false;
                await this.onMetaWindowActorExist(this.metaWindow);
                await this.onMetaWindowFirstFrameDrawn();
                WindowUtils.updateTitleBarVisibility(this.metaWindow);
                this.resizeMetaWindows();
                if (!this._metaWindow) {
                    if (
                        !this.msContent.has_style_class_name('surface-darker')
                    ) {
                        this.msContent.add_style_class_name('surface-darker');
                    }
                } else {
                    if (this.msContent.has_style_class_name('surface-darker')) {
                        this.msContent.remove_style_class_name(
                            'surface-darker'
                        );
                    }
                }
                if (this.placeholder.get_parent()) {
                    this.fadeOutPlaceholder();
                }
            } else {
                this.reactive = false;
                if (this.msContent.has_style_class_name('surface-darker')) {
                    this.msContent.remove_style_class_name('surface-darker');
                }
                if (!this.placeholder.get_parent()) {
                    this.msContent.add_child(this.placeholder);
                }
            }
            this.emit('title-changed', this.title);
        }

        takeFocus() {
            if (Me.msWindowManager.msDndManager.dragInProgress) return;
            if (this.dialogs.length) {
                this.dialogs[this.dialogs.length - 1].metaWindow.activate(
                    global.get_current_time()
                );
            } else if (this.metaWindow) {
                this.metaWindow.activate(global.get_current_time());
            } else {
                this.placeholder.grab_key_focus();
            }
        }

        kill() {
            let dialogPromises = this.dialogs.map((dialog) => {
                return new Promise((resolve) => {
                    delete dialog.metaWindow.msWindow;
                    if (dialog.metaWindow.get_compositor_private()) {
                        dialog.metaWindow.connect('unmanaged', (_) => {
                            resolve();
                        });
                        dialog.metaWindow.delete(global.get_current_time());
                    }
                });
            });
            let promise = new Promise((resolve) => {
                if (
                    this.metaWindow &&
                    this.metaWindow.get_compositor_private()
                ) {
                    delete this.metaWindow.msWindow;
                    this.metaWindow.connect('unmanaged', (_) => {
                        resolve();
                    });
                    this.metaWindow.delete(global.get_current_time());
                } else {
                    resolve();
                }
            });
            Promise.all([...dialogPromises, promise]).then(() => {
                if (this._persistent) {
                    this.unsetWindow();
                } else {
                    delete this.metaWindow;
                    this._onDestroy();
                    this.msWorkspace.removeMsWindow(this);
                    this.disconnect(this.destroyId);
                    this.destroy();
                }
            });

            return promise;
        }

        fadeOutPlaceholder() {
            const onComplete = () => {
                this.placeholder.set_opacity(255);
                if (this.metaWindow) {
                    this.msContent.remove_child(this.placeholder);
                }
                this.placeholder.reset();
            };

            this.placeholder.ease({
                opacity: 0,
                duration: 250,
                mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                onComplete,
            });
        }

        freezeAllocation() {
            this.set_width(this.allocation.get_width());
            this.set_height(this.allocation.get_height());
        }

        unFreezeAllocation() {
            this.set_width(-1);
            this.set_height(-1);
        }

        updateMetaWindowVisibility() {
            if (this.metaWindow) {
                logFocus(
                    this.visible,
                    this.get_parent(),
                    Me.msWindowManager.msDndManager.dragInProgress
                );
                let shouldBeHidden =
                    (!this.visible ||
                        this.get_parent() === null ||
                        Me.msWindowManager.msDndManager.dragInProgress) &&
                    !Me.msWorkspaceManager.noUImode;
                logFocus(`shouldBeHiddn`, this, shouldBeHidden);
                if (shouldBeHidden && !this.metaWindow.minimized) {
                    this.metaWindow.minimize();
                } else if (this.metaWindow.minimized) {
                    this.metaWindow.unminimize();
                }
            }
        }

        toString() {
            let string = super.toString();
            return `${string.slice(
                0,
                string.length - 1
            )} ${this.app.get_name()}]`;
        }

        _onDestroy() {
            this.unregisterOnMetaWindowSignals();
        }
    }
);

var MsWindowContent = GObject.registerClass(
    {
        GTypeName: 'MsWindowContent',
    },
    class MsWindowContent extends St.Widget {
        _init(placeholder, clone) {
            super._init({ clip_to_allocation: true });
            this.placeholder = placeholder;
            this.clone = clone;
            this.add_child(this.clone);
            this.add_child(this.placeholder);
        }

        vfunc_allocate(box, flags) {
            this.set_allocation(box, flags);
            let themeNode = this.get_theme_node();
            box = themeNode.get_content_box(box);
            let metaWindow = this.get_parent().metaWindow;
            if (metaWindow) {
                let windowFrameRect = metaWindow.get_frame_rect();
                let windowActor = metaWindow.get_compositor_private();
                //The WindowActor position are not the same as the real window position, I'm not sure why. We need to determine the offset to correctly position the windowClone inside the msWindow container;
                if (windowActor) {
                    let cloneBox = new Clutter.ActorBox();
                    if (metaWindow.resizeable || metaWindow.fullscreen) {
                        cloneBox.x1 = windowActor.x - windowFrameRect.x;
                        cloneBox.y1 = windowActor.y - windowFrameRect.y;
                        cloneBox.x2 = cloneBox.x1 + windowActor.width;
                        cloneBox.y2 = cloneBox.y1 + windowActor.height;
                    } else {
                        const monitor = this.get_parent().msWorkspace.monitor;
                        const workArea = Main.layoutManager.getWorkAreaForMonitor(
                            monitor.index
                        );
                        cloneBox.x1 =
                            windowActor.x - workArea.x - this.get_parent().x;
                        cloneBox.y1 =
                            windowActor.y - workArea.y - this.get_parent().y;
                        cloneBox.x2 = cloneBox.x1 + windowActor.width;
                        cloneBox.y2 = cloneBox.y1 + windowActor.height;
                    }

                    this.clone.allocate(cloneBox, flags);
                } else {
                    log('windowactor is missing', this.title);
                }
            }

            if (this.placeholder.get_parent() === this) {
                this.placeholder.set_size(box.get_width(), box.get_height());
                this.placeholder.allocate(box, flags);
            }
        }
    }
);
