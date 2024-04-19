import express from 'express';
import cors from 'cors';
import https from 'node:https';
import socketIO from 'socket.io';
import fs from 'fs';

import ManifoldTerminal from './terminal';

import * as IN from './inPacketIds';
import * as OUT from './outPacketIds';
import { BanList, Config, GameSettings, Player, RatelimitRestrictions } from './types';
import moment from 'moment';

const ratelimitMessages: Record<string, string> = {
  joining: 'join_rate_limited',
  chatting: 'chat_rate_limit',
  changingTeams: 'rate_limit_teams',
  readying: 'rate_limit_ready',
  transferringHost: 'host_change_rate_limited',
};

// Load SSL/TLS certificate files
const options = {
  key: fs.readFileSync('path/to/your/server.key'), //! <- Change this
  cert: fs.readFileSync('path/to/your/server.cert') //! <- Change this
};

export default class ManifoldServer {
  public config;

  public server: https.Server;
  public expressApp: express.Application;
  public io: socketIO.Server;

  public terminal: ManifoldTerminal;

  public playerInfo: Player[];
  public playerSockets: socketIO.Socket[];
  public ratelimits: Record<string, Record<string, number>>;
  public banList: BanList;
  public chatLog: string;

  public hostId: number;
  public gameStartTime: number;
  public gameSettings: GameSettings;

  public roomName: string;
  public password: string | null;
  public playerAmount: number;

  constructor(config: Config) {
    this.config = config;

    this.playerInfo = [];
    this.playerSockets = [];
    this.ratelimits = {};
    this.chatLog = '';

    this.hostId = -1;
    this.gameStartTime = 0;

    this.gameSettings = this.config.defaultGameSettings;
    this.roomName = this.config.roomNameOnStartup;
    this.password = this.config.roomPasswordOnStartup;
    this.playerAmount = 0;

    this.terminal = new ManifoldTerminal(this);

    // gather ban list
    if (fs.existsSync('./banlist.json')) {
      this.banList = JSON.parse(fs.readFileSync('./banlist.json', { encoding: 'utf8' }));
    } else {
      this.banList = { addresses: [], usernames: [] };
    }

    // init http server and metadata endpoint
    this.expressApp = express();
    this.server = https.createServer(options, this.expressApp); // Create HTTPS server
    
    this.expressApp.use(
      cors({
        origin: 'https://bonk.io',
        methods: ['GET', 'POST'],
        credentials: true,
      }),
    );

    this.expressApp.get('/', (_req, res) => {
      res.json({
        isBonkServer: true,
        roomname: this.roomName,
        password: this.password ? 1 : 0,
        players: this.playerAmount,
        maxplayers: this.config.maxPlayers,
        mode_ga: this.gameSettings.ga,
        mode_mo: this.gameSettings.mo,
      });
    });

    // init socket.io server and register socket connection events
    this.io = new socketIO.Server(this.server, {
      allowEIO3: true,
      cors: {
        origin: 'https://bonk.io',
        methods: ['GET', 'POST'],
        credentials: true,
      },
      transports: ['websocket', 'polling'],
    });

    this.io.on('connection', (socket) => {
      // timesync packet handling
      socket.conn.on('packet', (packet) => {
        if (/[0-9]\[18/.test(packet.data)) {
          const infoString = packet.data.replace(/.*(\{.+\})\]/, '$1');
          const timeSyncInfo = JSON.parse(infoString);

          socket.emit(OUT.REPLY_TIMESYNC, {
            id: timeSyncInfo.id,
            result: Date.now(),
          });
        }
      });

      // new player joins the room and sends this packet
      socket.on(IN.JOIN_REQUEST, (playerData) => {
        /* #region JOIN RESTRICTIONS */

        // banned check
        if (this.banList.addresses.includes(socket.handshake.address)) {
          socket.emit(OUT.ERROR_MESSAGE, 'banned');
          return;
        }

        // already joined check
        if (socket.data.bonkId !== undefined) return;

        // join ratelimit check
        if (this.processRatelimit(socket, 'joining')) return;

        // name duplicate check
        if (config.restrictions.usernames.noDuplicates) {
          for (const player of this.playerInfo) {
            if (!player) continue;

            if (player.userName === playerData.userName) {
              socket.emit(OUT.ERROR_MESSAGE, 'already_in_this_room');
              return;
            }
          }
        }

        // username length check
        if (playerData.userName.length > config.restrictions.usernames.maxLength) {
          socket.emit(OUT.ERROR_MESSAGE, 'username_too_long');
          return;
        }

        if (config.restrictions.usernames.noEmptyNames && !playerData.userName) {
          socket.emit(OUT.ERROR_MESSAGE, 'username_empty');
          return;
        }

        // password check
        if (this.password && playerData.roomPassword !== this.password) {
          socket.emit(OUT.ERROR_MESSAGE, 'password_wrong');
          return;
        }

        // max players check
        if (this.playerAmount == config.maxPlayers) {
          socket.emit(OUT.ERROR_MESSAGE, 'room_full');
          return;
        }

        /* #endregion JOIN RESTRICTIONS */

        this.registerSocketEvents(socket);
        socket.join('main');

        // assign id to new player and store it in the socket
        socket.data = {
          bonkId: this.playerInfo.length,
        };

        // add new player to the player socket and info lists
        this.playerSockets[socket.data.bonkId] = socket;
        this.playerInfo[socket.data.bonkId] = {
          peerId: 'invalid',
          userName: playerData.userName,
          guest: playerData.guest,
          team: this.gameSettings.tl ? 0 : 1,
          level: playerData.level,
          ready: false,
          tabbed: false,
          avatar: playerData.avatar,
        };

        this.playerAmount++;

        // emit initial lobby info to new player
        socket.emit(
          OUT.SERVER_INFORM,
          socket.data.bonkId,
          this.playerInfo[this.hostId] ? this.hostId : config.autoAssignHost ? socket.data.bonkId : -1,
          this.playerInfo,
          this.gameStartTime,
          this.gameSettings.tl,
          0,
          'invalid',
          null,
        );

        // notify everyone (but the new player) about the join
        socket.broadcast.emit(
          OUT.PLAYER_JOINED,
          socket.data.bonkId,
          'invalid',
          playerData.userName,
          playerData.guest,
          playerData.level,
          this.gameSettings.tl ? 0 : 1,
          playerData.avatar,
        );

        // log join message
        this.logChatMessage(`* ${playerData.userName} joined the game`);

        // if there's no host in the room, pretend to be the host and
        // send the "inform in lobby" packet. if autoAssignHost is on,
        // make the new player a host
        if (!this.playerInfo[this.hostId]) {
          if (config.autoAssignHost) this.hostId = socket.data.bonkId;
          socket.emit(OUT.HOST_INFORM_IN_LOBBY, this.gameSettings);
        }
      });
    });

    // start the server and the terminal
    this.server.listen(3000, () => {
      this.terminal.start();
    });
  }

  processRatelimit(socket: socketIO.Socket, actionType: keyof RatelimitRestrictions) {
    const socketAddress = socket.handshake.address;
    const ratelimitOptions = this.config.restrictions.ratelimits[actionType as keyof RatelimitRestrictions];

    this.ratelimits[socketAddress] ??= {};
    const socketRatelimits = this.ratelimits[socketAddress];

    socketRatelimits[actionType] ??= 0;

    if (socketRatelimits[actionType] == 0) {
      setTimeout(() => {
        if (socketRatelimits[actionType] >= ratelimitOptions.amount) return;

        socketRatelimits[actionType] = 0;
      }, ratelimitOptions.timeframe * 1000);
    }

    socketRatelimits[actionType]++;

    if (socketRatelimits[actionType] == ratelimitOptions.amount) {
      setTimeout(() => {
        socketRatelimits[actionType] = 0;
      }, ratelimitOptions.restore * 1000);
    }

    if (socketRatelimits[actionType] >= ratelimitOptions.amount) {
      socket.emit(OUT.ERROR_MESSAGE, ratelimitMessages[actionType]);

      return true;
    } else {
      return false;
    }
  }

  logChatMessage(content: string) {
    this.chatLog += `[${moment().format(this.config.timeStampFormat)}] ${content}\n`;
  }

  saveChatLog() {
    if (!fs.existsSync('./chatlogs')) fs.mkdirSync('./chatlogs');
    fs.writeFileSync(`./chatlogs/${moment().format(this.config.timeStampFormat)}.txt`, this.chatLog);
    this.chatLog = '';
  }

  banPlayer(id: number) {
    this.banList.addresses.push(this.playerSockets[id].handshake.address);
    this.banList.usernames.push(this.playerInfo[id].userName);

    fs.writeFileSync('./banlist.json', JSON.stringify(this.banList), {
      encoding: 'utf8',
    });

    this.logChatMessage(`${this.playerInfo[id].userName} was banned from the server`);
    this.playerSockets[id].disconnect();
  }

  kickPlayer(id: number) {
    this.logChatMessage(`${this.playerInfo[id].userName} was kicked from the server`);
    this.playerSockets[id].disconnect();
  }

  registerSocketEvents(socket: socketIO.Socket) {
    /* #region JOIN HANDLERS */

    // "inform in lobby" packet
    socket.on(IN.HOST_INFORM_IN_LOBBY, (data) => {
      if (socket.data.bonkId !== this.hostId) return;

      this.playerSockets[data.sid].emit(OUT.HOST_INFORM_IN_LOBBY, data.gs);
    });

    // "inform in game" packet
    socket.on(IN.HOST_INFORM_IN_GAME, (data) => {
      if (socket.data.bonkId !== this.hostId) return;

      this.playerSockets[data.sid].emit(OUT.HOST_INFORM_IN_GAME, data.allData);
    });

    /* #endregion JOIN HANDLERS */

    /* #region NON-HOST ACTIONS */

    // change own team
    socket.on(IN.CHANGE_OWN_TEAM, (data) => {
      if (this.processRatelimit(socket, 'changingTeams')) return;
      if (this.gameSettings.tl && socket.data.bonkId !== this.hostId) return;

      // change team in the player list
      this.playerInfo[socket.data.bonkId].team = data.targetTeam;

      // send team change packet to everyone
      this.io.to('main').emit(OUT.CHANGE_TEAM, socket.data.bonkId, data.targetTeam);
    });

    // send chat message
    socket.on(IN.CHAT_MESSAGE, (data) => {
      if (this.processRatelimit(socket, 'chatting')) return;

      // send chat message to everyone
      this.io.to('main').emit(OUT.CHAT_MESSAGE, socket.data.bonkId, data.message);

      // log chat message
      this.logChatMessage([this.playerInfo[socket.data.bonkId].userName, ': ', data.message].join(''));
    });

    // set own ready state
    socket.on(IN.SET_READY, (data) => {
      if (this.processRatelimit(socket, 'readying')) return;

      // send ready state to everyone
      this.io.to('main').emit(OUT.SET_READY, socket.data.bonkId, data.ready);
    });

    // send map request
    socket.on(IN.MAP_REQUEST, (data) => {
      if (this.processRatelimit(socket, 'chatting')) return;

      if (this.hostId == -1) {
        this.io.emit(OUT.MAP_REQUEST_NON_HOST, data.mapname, data.mapauthor, socket.data.bonkId);
      } else {
        // send map request packet to everyone but the host (only contains metadata of the map)
        this.playerSockets[this.hostId].broadcast.emit(
          OUT.MAP_REQUEST_NON_HOST,
          data.mapname,
          data.mapauthor,
          socket.data.bonkId,
        );

        // send map request packet to host (contains the actual map)
        this.playerSockets[this.hostId].emit(OUT.MAP_REQUEST_HOST, data.m, socket.data.bonkId);
      }

      // log map request
      this.logChatMessage(
        [
          '* ',
          this.playerInfo[socket.data.bonkId].userName,
          ' has requested the map ',
          data.mapname,
          ' by ',
          data.mapauthor,
        ].join(''),
      );
    });

    // send friend request
    socket.on(IN.FRIEND_REQUEST, (data) => {
      // send friend request packet to the target player
      this.playerSockets[data.id].emit(OUT.FRIEND_REQUEST, socket.data.bonkId);
    });

    // set tabbed (afk) state
    socket.on(IN.SET_TABBED, (data) => {
      // send tabbed (afk) state to everyone
      this.io.to('main').emit(OUT.SET_TABBED, socket.data.bonkId, data.out);
    });

    // (unhandled) 33: save replay to main menu
    // (unhandled) 38: request xp increase
    // (unhandled) 39: vote map
    // (unhandled) 51: curate map

    /* #endregion NON-HOST ACTIONS */

    /* #region HOST ACTIONS */

    // lock teams
    socket.on(IN.LOCK_TEAMS, (data) => {
      if (this.processRatelimit(socket, 'changingTeams')) return;
      if (socket.data.bonkId !== this.hostId) return;

      this.gameSettings.tl = data.teamLock;

      this.io.to('main').emit(OUT.LOCK_TEAMS, data.teamLock);
    });

    // kick/ban player
    socket.on(IN.KICK_BAN_PLAYER, (data) => {
      if (socket.data.bonkId !== this.hostId) return;

      if (data.kickonly) {
        this.kickPlayer(data.banshortid);
      } else {
        this.banPlayer(data.banshortid);
      }
    });

    // change mode
    socket.on(IN.CHANGE_MODE, (data) => {
      if (this.processRatelimit(socket, 'changingMode')) return;
      if (socket.data.bonkId !== this.hostId) return;

      this.gameSettings.ga = data.ga;
      this.gameSettings.mo = data.mo;

      this.io.to('main').emit(OUT.CHANGE_MODE, data.ga, data.mo);
    });

    // change rounds to win
    socket.on(IN.CHANGE_ROUNDS, (data) => {
      if (socket.data.bonkId !== this.hostId) return;

      this.gameSettings.wl = data.w;

      this.io.to('main').emit(OUT.CHANGE_ROUNDS, data.w);
    });

    // change current map
    socket.on(IN.CHANGE_MAP, (data) => {
      if (this.processRatelimit(socket, 'changingMap')) return;
      if (socket.data.bonkId !== this.hostId) return;

      this.gameSettings.map = data.m;

      this.io.to('main').emit(OUT.CHANGE_MAP, data.m);
    });

    // change someone's team
    socket.on(IN.CHANGE_OTHER_TEAM, (data) => {
      if (this.processRatelimit(socket, 'changingTeams')) return;
      if (socket.data.bonkId !== this.hostId) return;

      // change team in the player list
      this.playerInfo[data.targetID].team = data.targetTeam;

      // send team change packet to everyone
      this.io.to('main').emit(OUT.CHANGE_TEAM, data.targetID, data.targetTeam);
    });

    // change someone's balance (nerf/buff)
    socket.on(IN.CHANGE_BALANCE, (data) => {
      if (socket.data.bonkId !== this.hostId) return;

      // change balance in the game settings
      this.gameSettings.bal[data.sid] = data.bal;

      // send balance change packet to everyone
      this.io.to('main').emit(OUT.CHANGE_BALANCE, data.sid, data.bal);
    });

    // enable/disable teams
    socket.on(IN.TOGGLE_TEAMS, (data) => {
      if (socket.data.bonkId !== this.hostId) return;

      // change team enable/disable in the game settings
      this.gameSettings.tea = data.t;

      // send team enable/disable packet to everyone
      this.io.to('main').emit(OUT.TOGGLE_TEAMS, data.t);
    });

    // transfer host
    socket.on(IN.TRANSFER_HOST, (data) => {
      if (this.processRatelimit(socket, 'transferringHost')) return;
      if (socket.data.bonkId !== this.hostId) return;

      const oldHostId = this.hostId;

      // change host id
      this.hostId = data.id;

      // send host change packet to everyone
      this.io.to('main').emit(OUT.TRANSFER_HOST, { oldHost: oldHostId, newHost: this.hostId });

      // log host transfer message
      this.logChatMessage(`* ${this.playerInfo[this.hostId].userName} is now the game host`);
    });

    // send countdown "starting in" message
    socket.on(IN.SEND_COUNTDOWN_STARTING, (data) => {
      if (this.processRatelimit(socket, 'startGameCountdown')) return;
      if (socket.data.bonkId !== this.hostId) return;

      this.io.to('main').emit(OUT.SEND_COUNTDOWN_STARTING, data.num);
    });

    // send countdown "aborted" message
    socket.on(IN.SEND_COUNTDOWN_ABORTED, () => {
      if (this.processRatelimit(socket, 'startGameCountdown')) return;
      if (socket.data.bonkId !== this.hostId) return;

      this.io.to('main').emit(OUT.SEND_COUNTDOWN_ABORTED);
    });

    // (unhandled) 50: close the room

    /* #endregion HOST ACTIONS */

    /* #region IN-GAME ACTIONS */

    // send inputs
    socket.on(IN.SEND_INPUTS, (data) => {
      socket.broadcast.emit(OUT.SEND_INPUTS, socket.data.bonkId, data);
    });

    // host start game
    socket.on(IN.START_GAME, (data) => {
      if (this.processRatelimit(socket, 'startingEndingGame')) return;
      if (socket.data.bonkId !== this.hostId) return;

      this.gameSettings = data.gs;
      this.gameStartTime = Date.now();

      this.io.to('main').emit(OUT.START_GAME, this.gameStartTime, data.is, data.gs);
    });

    // host end game
    socket.on(IN.END_GAME, () => {
      if (this.processRatelimit(socket, 'startingEndingGame')) return;
      if (socket.data.bonkId !== this.hostId) return;

      this.io.to('main').emit(OUT.END_GAME);
    });

    // (unhandled) 41: get map votes

    /* #endregion IN-GAME ACTIONS */

    socket.on('disconnect', () => {
      if (socket.data.bonkId === undefined) return;

      const leavingPlayerId = socket.data.bonkId;

      // this is the amount of game ticks (bonk runs at 30tps) at which the player left
      const tickCount = Math.round((Date.now() - this.gameStartTime) / (1000 / 30));

      if (this.config.autoAssignHost && socket.data.bonkId == this.hostId) {
        let newHostId = -1;

        for (let i = 0; i < this.playerSockets.length; i++) {
          if (this.playerSockets[i]) {
            newHostId = i;
            break;
          }
        }

        // log disconnect message
        if (newHostId == -1) {
          this.logChatMessage(`* ${this.playerInfo[leavingPlayerId].userName} left the game`);
        } else {
          this.logChatMessage(
            `* ${this.playerInfo[leavingPlayerId].userName} left the game and ${this.playerInfo[newHostId].userName} is now the game host`,
          );
        }

        this.hostId = newHostId;
        this.io.to('main').emit(OUT.HOST_LEFT, socket.data.bonkId, newHostId, tickCount);
      } else {
        if (socket.data.bonkId == this.hostId) this.hostId = -1;

        // log disconnect message
        this.logChatMessage(`* ${this.playerInfo[leavingPlayerId].userName} left the game`);

        this.io.to('main').emit(OUT.PLAYER_LEFT, socket.data.bonkId, tickCount);
      }

      delete this.playerInfo[socket.data.bonkId];
      delete this.playerSockets[socket.data.bonkId];

      this.playerAmount--;
    });
  }
}
