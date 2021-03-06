var processes = {};
var workers = {};
var accounts = {};
var TimeSlice = 1 // minutes
var updateTimer = null;

var getCurrentT = function() {
  return Math.floor(Date.now() / (TimeSlice * 60000));
};

var initWorker = function(sid, wid) {
    return {
      sid: sid,
      wid: wid,
      spin: 0,
      pokemon: 0,
      captcha: 0,
    };
};

var initTimeslice = function(sliceId) {
  return {
    sliceId: sliceId,
    spin: 0,
    spinPh: 0.0,
    pokemon: 0,
    pokemonPh: 0.0,
    captcha: 0,
    captchaPh: 0.0,
    hashingTimeout: 0,
    hashingTimeoutPh: 0.0,
  };
};

var initProcess = function(sid) {
  return {
    sid: sid,
    lastUpdated: 0,
    lastPokemon: 0,
    currentTimeSlice: initTimeslice(getCurrentT()),
    timeSlices: {},
  };
};

var updateTimeslices = function() {
  for (var sid in processes) {
    var currentT = getCurrentT();
    var proc = processes[sid];
    var timeSlices = proc.timeSlices;

    cleanupTimeslices(timeSlices, currentT);

    if (proc.currentTimeSlice.sliceId != currentT) {
      proc.currentTimeSlice = initTimeslice(currentT);
    }

    if (!proc.timeSlices[proc.currentTimeSlice.sliceId]) {
      proc.timeSlices[proc.currentTimeSlice.sliceId] = proc.currentTimeSlice;
    }

    var timeSlice = proc.currentTimeSlice;

    var numSlices = 60.0 / TimeSlice;

    timeSlice.spinPh = timeSlice.spin * numSlices;
    timeSlice.pokemonPh = timeSlice.pokemon * numSlices;
    timeSlice.captchaPh = timeSlice.captcha * numSlices;
    timeSlice.hashingTimeoutPh = timeSlice.hashingTimeout * numSlices;

    var timeSliceValues = [];
    for (var k in timeSlices) {
      timeSliceValues.push(timeSlices[k]);
    }

    var stats = timeSliceValues.reduce(function(s, o) {
      return {
        spin: s.spin + o.spin,
        pokemon: s.pokemon + o.pokemon,
        captcha: s.captcha + o.captcha,
        hashingTimeout: s.hashingTimeout + o.hashingTimeout,
      };
    }, {
      spin: 0,
      pokemon: 0,
      captcha: 0,
      hashingTimeout: 0,
    });

    var sliceCount = Object.keys(timeSlices).length;

    stats.spinPh = (stats.spin / sliceCount) * numSlices;
    stats.pokemonPh = (stats.pokemon / sliceCount) * numSlices;
    stats.captchaPh = (stats.captcha / sliceCount) * numSlices;
    stats.hashingTimeoutPh = (stats.hashingTimeout / sliceCount) * numSlices;

    proc.stats = stats;
  }
};

var cleanupTimeslices = function(timeSlices, currentT) {
  for (var t in timeSlices) {
    var slice = timeSlices[t];
    var numSlices = parseInt(60.0 / TimeSlice); 
    // Leave 1 hr worth of slices
    if (slice.sliceId < (currentT - numSlices)) {
      delete timeSlices[t];
    }
  }
};

var initAccount = function(sid, aid) {
  return {
    sid: sid,
    aid: aid,
  };
};

var updateAccount = function(str, sid) {
  var getAccount = function(aid) {
    if (!accounts[aid]) {
      accounts[aid] = initAccount(sid, aid);
    }
    return accounts[aid];
  };

  if (matches = str.match(/Auth error on ([^:]+): Account email not verified/)) {
    var account = getAccount(matches[1]);
    account.unverifiedEmail = true;
  }

  if (matches = str.match(/\[worker-(\d)+\] (.+) has encountered a CAPTCHA/)) {
    var wid = parseInt(matches[1]);
    var account = getAccount(matches[2]);

    if (!account.captchaEncountered) {
      account.captchaEncountered = 0;
    }

    account.captchaEncountered += 1;

    var wkey = sid + '-' + wid;
    var worker = workers[wkey];

    if (worker) {
      worker.captcha += 1;
    }
    processes[sid].currentTimeSlice.captcha += 1;
  }

  if (matches = str.match(/\] (.+) received code 3 and is likely banned/)) {
    var account = getAccount(matches[1]);
    account.banned = true;
  }
};

var updateWorker = function(str, sid) {
  if (matches = str.match(/\[worker-(\d+)\]/)) {
    var workerId = parseInt(matches[1]);
    var k = sid + '-' + workerId;

    if (!workers[k]) {
      workers[k] = initWorker(sid, workerId);
    }

    var worker = workers[k];

    if (matches = str.match(/Spun/)) {
      worker.spin += 1;
      processes[sid].currentTimeSlice.spin += 1;
    }

    if (matches = str.match(/Point processed, (\d+) Pokemon/)) {
      worker.pokemon += 1;
      processes[sid].currentTimeSlice.pokemon += 1;
      processes[sid].lastPokemon = Date.now();
    }
  }
};

var updateProcess = function(str, sid) {
  processes[sid].lastUpdated = Date.now();
  if (processes[sid].lastPokemon === 0) {
    processes[sid].lastPokemon = Date.now();
  }

  if (matches = str.match(/Hashing request timed out/)) {
    if (!processes[sid]) {
      processes[sid] = initProcess(sid);
    }
    processes[sid].currentTimeSlice.hashingTimeout += 1;
  }
};

var deadProcesses = function() {
  var dead = {};
  var cutoff = Date.now() - (30 * 1000);
  for (var sid in processes) {
    var proc = processes[sid];
    var currentTS = proc.currentTimeSlice;
    if (proc.lastUpdated < cutoff) {
      console.log("%d is dead due to inactivity", sid);
      dead[sid] = proc.lastUpdated;
    } else if (currentTS && currentTS.pokemon === 0 && currentTS.hashingTimeout > 15) {
      console.log("%d is dead due to hashingTimeout", sid);
      dead[sid] = 0;
    } else if (proc.lastUpdated > 0 && proc.lastPokemon > 0 && (proc.lastUpdated - proc.lastPokemon) > (7 * 60 * 1000)) {
      console.log("%d is dead due to no pokemon found for more than 7 mins, lastUpdated: %s, lastPokemon: %s", sid, proc.lastUpdated, proc.lastPokemon);
      dead[sid] = proc.lastPokemon;
    }
  }
  return dead;
};

module.exports.deinitSid = function(sid) {
  delete processes[sid];

  for (var k in workers) {
    var worker = workers[k];
    if (worker.sid === sid) {
      delete workers[k];
    }
  }
};

module.exports.initSid = function(sid) {
  processes[sid] = initProcess(sid);
};

module.exports.parse = function(str, sid) {
  if (processes[sid]) {
    updateProcess(str, sid);
    updateWorker(str, sid);
    updateAccount(str, sid);
  }
};

module.exports.stats = function() {

  var dead = deadProcesses();

  var procs = {};
  for (var k in processes) {
    var o = processes[k];
    procs[k] = {
      currentTimeSlice: o.currentTimeSlice,
      lastUpdated: o.lastUpdated,
      sid: o.sid,
      stats: o.stats,
    };
  }

  return {
    processStats: procs,
    processCount: Object.keys(processes).length,
    deadProcessCount: Object.keys(dead).length,
    deadProcesses: dead,
    accountErrors: accounts,
  };
};

updateTimer = setInterval(function() {
  //updateCurrentTimeslices();
  updateTimeslices();
}, 5000);

