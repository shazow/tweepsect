var remaining_hits = 200;
var confirmed_api = false;
var now = new Date();

/* A simple throbber, for the lols and bonus internets. */
function throbber() {
    throbber.pos += 1;
    if(throbber.pos > throbber.animation.length - 1) throbber.pos = 0;
    return throbber.animation[throbber.pos];
}
throbber.pos = 0;
throbber.animation = ["|","/","-","\\"];

/* Wrapper function for logging the progress. Utilizes the throbber. */
function log(msg, extra) {
    $("#progress").html("[" + throbber() +"] " + msg).attr("title", extra ? extra : "");
}

function compare_numerically(a, b) {
    return a - b;
}

function compare_humanly(a, b) {
    return a.toLowerCase() - b.toLowerCase();
}

/***/

function CounterCallback(count, callback) {
    /* Returns a function that triggers `callback` after being called `count` times. */

    this.count = count;
    this.callback = callback;

    var self = this;
    return function() { self.next(); }
}

CounterCallback.prototype.next = function() {
    this.count--;
    if(this.count <= 0) this.callback();
}

/***/

function TweepSet(label, target) {
    /* Container for TweepSets */
    this.label = label;
    this.target = target;
    this.members = new Array();
    this.manifest = {};
    this.count = 0;
}

TweepSet.prototype.set_population = function(population) {
    /* Initialize the column and compute the manifest hash table */
    this.count = population.length;
    $(this.target).empty().append("<h2>" + this.label + " <span class=\"number\">(" + this.count + ")</span></h2><ul></ul>");

    var self = this;
    $.each(population, function(i, id) { self.manifest[id] = true; });
}

TweepSet.prototype.add_member = function(tweep, fade) {
    /* If tweep is a member, insert it in sorted order */
    if(!this.manifest[tweep.id]) return;

    this.manifest[tweep.id] = false; // Nullify it for the future

    var pos = insert_index(this.members, tweep.screen_name, function(a, b) { return a.toLowerCase() < b.toLowerCase() })
    var row = $("<li></li>").html('<a href="http://twitter.com/'+ tweep.screen_name +'" target="_blank">'+ tweep.screen_name +'</a>');

    var last_tweet = tweep['status'] && Date.parse(tweep['status']['created_at']);

    if(last_tweet && now - last_tweet > 3*30*24*60*60*1000) { // 3 months
        $("a", row).append(' <i class="twitter_sprite stale" title="Inactive for more than 3 months."></i>');
    }

    row[0].info = tweep;
    decorate_tweep(row);

    if(fade) row.addClass("hidden").hide();

    this.members.splice(pos, 0, tweep.screen_name);

    if(pos==0) {
        $("ul", this.target).prepend(row);
    } else {
        $("ul li:nth-child(" + pos + ")", this.target).after(row);
    }
}

/***/

function check_limit(success_callback) {
/* Fetch the current remaining_hits status for the user's Twitter API. */
log("Checking Twitter API query limits.");

var api_target = "https://api.twitter.com/1/account/rate_limit_status.json"
return query_twitter(api_target, {}, function(data) {
    remaining_hits = data.remaining_hits;
    success_callback();
});
}

function get_followx(type, screen_name, callback) {
var users_hash = {};
var users_array = [];

query_twitter("https://api.twitter.com/1/"+ type +"/ids.json", {screen_name: screen_name}, function(data) {
    $.each(data, function(i, id) { users_hash[id] = true; users_array.push(id); });
    callback(users_hash, users_array.sort(compare_numerically));
});
}

function get_following(screen_name, callback) { get_followx("friends", screen_name, callback); }
function get_followers(screen_name, callback) { get_followx("followers", screen_name, callback); }

function get_social_ids(screen_name, callback) {
log("Loading social network counts.");
var only_followers = new Array();
var only_following = new Array();
var mutual = new Array();

get_following(screen_name, function(following_hash, following) { get_followers(screen_name, function(followers_hash, followers) {
    /// TODO: This could be done better...
    load_diffs(following, followers, only_followers, only_following, mutual);

    callback({
        only_followers: only_followers,
        only_following: only_following,
        mutual: mutual,
        following: following,
        following_hash: following_hash,
        followers: followers,
        followers_hash: followers_hash
        });

    }); });
}

/* Confirmation message for when we're starting to get low on remaining hits. */
function confirm_api() {
    if(remaining_hits<5) {
        log("Getting dangerously close to getting banned from Twitter. No more requests for a while, please.");
        return false;
    }
    confirmed_api = confirmed_api || confirm("Warning: Performing too many queries on the Twitter API could cause Twitter to block you temporarily. You have " + remaining_hits + " queries remaining for this hour, are you sure you want to continue?");
    return confirmed_api;
}

function query_twitter(api_target, params, callback) {
    remaining_hits -= 1;
    return OAuth.getJSON(api_target, params, callback, function() {
        log("Twitter API is suffering from epic failulitis. Refresh and hope for the best?");       
    });
}

function load_twitter(api_target, cursor, item_callback, iter_callback, success_callback) {
    return query_twitter(api_target, {'cursor': cursor}, function(data) {
        if(data.error) {
            log("Twitter returned an error: " + data.error);
            return;
        }
        $.each(data.users, function(i, item) { item_callback(item); });

        iter_callback(data.users.length);

        if(data.next_cursor && (remaining_hits > 30 || confirm_api())) {
            load_twitter(api_target, data.next_cursor, item_callback, iter_callback, success_callback);
        } else {
            if($.isFunction(success_callback)) success_callback();
        }
    });
}

function load_followers(username, item_callback, iter_callback, success_callback) {
    var api_target = "https://api.twitter.com/1/statuses/followers/" + username + ".json";
    load_twitter(api_target, -1, item_callback, iter_callback, success_callback);
}

function load_following(username, item_callback, iter_callback, success_callback) {
    var api_target = "https://twitter.com/1/statuses/friends/" + username + ".json";
    load_twitter(api_target, -1, item_callback, iter_callback, success_callback);
}

function load_diffs(following, followers, only_followers, only_following, mutual) {
    /* Calculate the set differences between the ``following`` and ``followers`
     * and shove them into the appropriate arrays.
     */
    $.each(following, function(i, item) {
        if(!in_array(followers, item)) {
            only_following.push(item);
        } else {
            mutual.push(item);
        }
    });

    $.each(followers, function(i, item) {
        if(!in_array(following, item)) {
            only_followers.push(item);
        }
    });
}


var RE_TMPL = /{{([\w\s]+?)}}/g;
var template_cache = {};

function render_template(template_name, context) {
    var html = template_cache[template_name];
    if(!html) {
        html = $("#templates #" + template_name).remove().html();
        html = html.replace("%7B%7B", "{{").replace(/%20/g, " ").replace("%7D%7D", "}}"); // Fix src
        template_cache[template_name] = html;
    }
    var ctx = html.match(RE_TMPL);
    $.each(ctx, function(i, v) {
        var v_stripped = this.substr(2, this.length-4); // Cut out the braces
        v_stripped = $.trim(v_stripped);
        var val = context[v_stripped];
        if(val!=undefined) html = html.replace(this, val);
    });

    return html;
}

function decorate_tweep(item) {
    foo = item;
    $(item).hover(
        function() {
            var info  = this.info;
            info['friends_count'] = info['friends_count'] || 0;
            info['followers_count'] = info['followers_count'] || 0;
            info['last_tweet'] = (info['status'] && relative_time(info['status']['created_at'])) || "never made";

            var html = $(render_template("floating_info_template", info));

            var self = this;
            $(".follow", html).click(function() {
                follow(info.screen_name);
                $(self).removeClass("unfollowed");
                $(self).addClass("followed");
            });
            $(".unfollow", html).click(function() {
                unfollow(info.screen_name);
                $(self).removeClass("followed");
                $(self).addClass("unfollowed");
            });
            this.floating_info = html;
            $(this).append(html);
            $(this).addClass("floating_row");
        },
        function() {
            $(this).removeClass("floating_row");
            $(this.floating_info).remove();
        }
    );
}

THANKS_PHRASES = [
    "Found my Twitter stalkers using Tweepsect, try it! http://tweepsect.com/",
    "I &hearts; Tweepsect, try it! http://tweepsect.com/"
];

function show_thanks() {
    $("#say_thanks").show();
    $("#say_thanks textarea").val(THANKS_PHRASES[0]); /// TODO: Randomize
}

function get_results() {
    $("#intro").hide();
    try { _gat._getTracker("UA-407051-5")._trackPageview("/query"); } catch(err) {}


    var username = $("#username").attr("value");
    if(!username) {
        log("Pick a tweep means put a Twitter username in the input box, like 'shazow'. Try it.");
        return;
    }
    if(username[0] == "@") username = username.substr(1);

    var tset_mutual = new TweepSet("Mutual", $("#mutual"));
    var tset_only_following = new TweepSet("Stalking", $("#only_following"));
    var tset_only_followers = new TweepSet("Stalkers", $("#only_followers"));

    var time_start = (new Date).getTime();
    var MAX_FADE = 1000; // When there's too much on the screen, it gets laggy

    check_limit(function() {
        var hits_start = remaining_hits;

        get_social_ids(username, function(r) {
            var expected_total = r['followers'].length + r['following'].length;
            var processed_count = 0;

            // Fill the TweepSet columns
            tset_mutual.set_population(r['mutual']);
            tset_only_following.set_population(r['only_following']);
            tset_only_followers.set_population(r['only_followers']);

            function render_item(item) {
                /* (Called for every item) Notify each TweepSet of a potential new member */
                var fade = processed_count < MAX_FADE;
                tset_mutual.add_member(item, fade);
                tset_only_following.add_member(item, fade);
                tset_only_followers.add_member(item, fade);
            }

            function iter_callback(num) {
                /* (Called for every query) Perform fade and update progress */
                var fade = processed_count < MAX_FADE;
                if(fade) $(".hidden").removeClass("hidden").fadeIn();

                processed_count += num;
                log("Fetching tweeps: " + Math.round((processed_count / expected_total) * 100) + "%");
            }

            var c = new CounterCallback(2, function() {
                /* Callback to trigger when both parallel AJAX chains are done */
                var time_elapsed = (new Date).getTime() - time_start;
                log("Done! With " + remaining_hits + " API calls left to spare, do another?",
                    processed_count + " tweeps loaded using " + (hits_start - remaining_hits) + " API calls in " + time_elapsed/1000 + " seconds.");
                show_thanks();
            });

            log("Fetching tweeps: 0%");

            // Start parallel AJAX chains, wee
            load_followers(username, render_item, iter_callback, c);
            load_following(username, render_item, iter_callback, c);
        });
    });
}

function unfollow(screen_name) {
    log("Unfollowing...");
    var api_target = "https://api.twitter.com/1/friendships/destroy/" + screen_name +".xml";

    remaining_hits -= 1;
    OAuth.post(api_target, {}, function() {
        log("Unfollowed: " + screen_name);
    });
}

function follow(screen_name) {
    log("Following...");
    var api_target = "https://api.twitter.com/1/friendships/create/" + screen_name +".xml";

    remaining_hits -= 1;
    OAuth.post(api_target, {}, function() {
        log("Followed: " + screen_name);
    });
}

function post_tweet(text) {
    log("Posting tweet...");
    var api_target = "https://api.twitter.com/1/statuses/update.xml";

    remaining_hits -= 1;
    OAuth.post(api_target, {"status": text}, function() {
        log("Posted tweet, thank you! :)");
    });

}

function tweepsect(screen_name) {
    $("#username").attr("value", screen_name);
    get_results();
}

/***/


// Based on:
//+ Carlos R. L. Rodrigues
//@ http://jsfromhell.com/array/search [rev. #2]
// Modified by Andrey Petrov for simplicity.
in_array = function(o, v) {
    /* For sorted array o, find v using binary search, returns bool */
    var h = o.length, l = -1, m;
    while(h - l > 1)
        if(o[m = h + l >> 1] < v) l = m;
        else h = m;
    return o[h] == v;
};

insert_index = function(o, v, cmp) {
    /* For sorted array o, return appropriate index position to insert v, using binary search */
    if(!cmp) {
        var cmp = function(a, b) { return a < b; };
    }
    var h = o.length, l = -1, m;
    while(h - l > 1)
        if(cmp(o[m = h + l >> 1], v)) l = m;
        else h = m;
    return h;
};

/* Borrowed from http://github.com/seaofclouds/tweet/ */
function relative_time(time_value) {
    var parsed_date = Date.parse(time_value);
    var relative_to = (arguments.length > 1) ? arguments[1] : new Date();
    var delta = parseInt((relative_to.getTime() - parsed_date) / 1000);
    if(delta < 60) {
    return 'less than a minute ago';
    } else if(delta < 120) {
    return 'about a minute ago';
    } else if(delta < (45*60)) {
    return (parseInt(delta / 60)).toString() + ' minutes ago';
    } else if(delta < (119*60)) {
    return 'about an hour ago';
    } else if(delta < (24*60*60)) {
    return 'about ' + (parseInt(delta / 3600)).toString() + ' hours ago';
    } else if(delta < (48*60*60)) {
    return '1 day ago';
    } else {
    return (parseInt(delta / 86400)).toString() + ' days ago';
    }
}
