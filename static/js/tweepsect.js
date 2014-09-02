var total_api_requests = 0;
var remaining_hits = 200;
var remaining_lookup = {};
var confirmed_api = false;
var now = new Date();
var twitter_api_prefix = 'https://api.twitter.com/1.1'

var whitelist;

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
    $("#progress").html("[" + throbber() +"] " + msg).prop("title", extra ? extra : "");
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

    var created_at = new Date(tweep['created_at']);
    var age_days = Math.round((new Date() - created_at) / (1000.0 * 60 * 60 * 24));
    var tweet_rate = Number(tweep['statuses_count'] / age_days).toFixed(1);
    tweep['created_year'] = created_at.getFullYear();
    tweep['tweet_rate'] = tweet_rate;

    if (tweet_rate > 10) {
        $("a", row).append(' <i class="twitter_sprite loud" title="'+ tweet_rate +' tweets per day."></i>');
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

function get_min_limit() {
    var min_percents = $.map(remaining_lookup, function(v, k) { return v.percent; });
    return Math.min.apply(Math, min_percents);
}

function check_limit(success_callback) {
    /* Fetch the current remaining_hits status for the user's Twitter API. */
    log("Checking Twitter API query limits.");

    var targets = [
        {name: 'friends', resource: '/friends/ids'},
        {name: 'followers', resource: '/followers/ids'},
        {name: 'lists', resource: '/lists/members'},
        {name: 'users', resource: '/users/lookup'}
    ];
    var resource_list_str = $(targets).map(function(i, o) { return o.name }).toArray().join(',');
    var api_target = "/application/rate_limit_status.json?resources=" + resource_list_str;

    return query_twitter(api_target, {}, function(data) {
        var all_remaining = $(targets).map(function(i, o) {
            var r = data['resources'][o.name][o.resource];
            remaining_lookup[o.resource] = r;
            r.percent = (r.remaining / r.limit) * 100;
            return r.remaining;
        });
        remaining_hits = Math.min.apply(Math, all_remaining);
        success_callback();
    });
}

function get_followx(type, screen_name, callback) {
    var users_hash = {};
    var users_array = [];

    function with_paging(cursor) {
        query_twitter("/" + type + "/ids.json", {screen_name: screen_name, cursor: cursor}, function(data) {
            $.each(data.ids, function(i, id) { users_hash[id] = true; users_array.push(id); });

            if(data.next_cursor && data.next_cursor > 0) {
                with_paging(data.next_cursor);
            } else {
                callback(users_hash, users_array.sort(compare_numerically));
            }
        });
    }
    with_paging(-1);
}

function get_following(screen_name, callback) { get_followx("friends", screen_name, callback); }
function get_followers(screen_name, callback) { get_followx("followers", screen_name, callback); }

function get_social_ids(screen_name, callback) {
    log("Loading social network counts.");
    var only_followers = new Array();
    var only_following = new Array();
    var mutual = new Array();

    get_following(screen_name, function(following_hash, following) {
        get_followers(screen_name, function(followers_hash, followers) {
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
        });
    });
}

/* Confirmation message for when we're starting to get low on remaining hits. */
function confirm_api() {
    if(get_min_limit() < 15) {
        log("Getting dangerously close to getting banned from Twitter. No more requests for a while, please.");
        return false;
    }
    confirmed_api = confirmed_api || confirm("Warning: Performing too many queries on the Twitter API could cause Twitter to block you temporarily.\n\nYou have " + Math.round(get_min_limit()) + "% of your queries remaining for the next 15 minutes, are you sure you want to continue?\n\n(Safest to wait 15 minutes and try again.)");
    return confirmed_api;
}

function query_twitter(api_target, params, callback) {
    var remaining = remaining_lookup[api_target];
    if (remaining) {
        remaining.remaining -= 1;
        remaining.percent = (remaining.remaining / remaining.limit) * 100;
    }
    total_api_requests += 1;

    var target_url = twitter_api_prefix + api_target;
    return OAuth.getJSON(target_url, params, callback, function() {
        // Retry one more time for kicks:
        return OAuth.getJSON(target_url, params, callback, function() {
            log("Twitter API is suffering from epic failulitis. Refresh and hope for the best?");
        });
    });
}

function load_twitter(api_target, cursor, item_callback, iter_callback, success_callback) {
    return query_twitter(api_target, {'cursor': cursor}, function(data) {
        if(data.error) {
            log("Twitter returned an error: " + data.error);
            return;
        }
        $.each(data.users, function(i, item) { item_callback(item); });

        if($.isFunction(iter_callback)) iter_callback(data.users.length);

        if(data.next_cursor && data.next_cursor > 0 && (get_min_limit() > 35 || confirm_api())) {
            load_twitter(api_target, data.next_cursor, item_callback, iter_callback, success_callback);
        } else {
            if($.isFunction(success_callback)) success_callback();
        }
    });
}

function load_followers(username, item_callback, iter_callback, success_callback) {
    var api_target = "/followers/list.json?screen_name=" + username;
    load_twitter(api_target, -1, item_callback, iter_callback, success_callback);
}

function load_following(username, item_callback, iter_callback, success_callback) {
    var api_target = "/friends/list.json?screen_name=" + username;
    load_twitter(api_target, -1, item_callback, iter_callback, success_callback);
}

function load_list_members(username, slug, item_callback, iter_callback, success_callback) {
    var api_target = "/lists/members.json?owner_screen_name=" + username + "&slug=" + slug;
    load_twitter(api_target, -1, item_callback, iter_callback, success_callback);
}

function load_users(user_ids, item_callback, iter_callback, success_callback) {
    var api_target = "/users/lookup.json";

    function get_user_ids() {
        var ids = [];
        for(var i=100; i>0; i--) {
            var id = user_ids.shift();
            if(!id) break;
            ids.push(id);
        }
        return ids;
    }

    function callback(data) {
        if(data) {
            if(data.error) {
                log("Twitter returned an error: " + data.error);
                return;
            }
            $.each(data, function(i, item) { item_callback(item); });
            if($.isFunction(iter_callback)) iter_callback(data.length);
        }

        var ids = get_user_ids().join(',');
        if(!ids) {
            if($.isFunction(success_callback)) success_callback();
            return;
        }

        if (get_min_limit() > 35 || confirm_api()) {
            query_twitter(api_target, {'user_id': ids}, callback);
        }
    }

    // Commence recursing
    callback();
}


function generate_whitelist(username, slug) {
    whitelist = {};
    load_list_members(username, slug, function(item) {
        whitelist[item.id] = true;
    });
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

function set_thanks_text(s, variation_label) {
    var href = 'https://twitter.com/home?status=' + encodeURI(s);
    $(".thanks-link").attr('href', href);
}

function show_thanks(num_mutual, num_stalking, num_stalkers) {
    // "A-B test" the message, for funsies.
    if (Math.random() < 0.5) {
        set_thanks_text("Found my Twitter stalkers using Tweepsect (" + num_stalkers + " stalkers and " + num_mutual +" mutual friends), try it! http://tweepsect.com/", 1);
    } else {
        set_thanks_text("Found my " + num_stalkers + " stalkers on Twitter (and " + num_mutual + " mutual friends) by using Tweepsect, try it out! http://tweepsect.com/", 2);
    }
}

function parse_username(input) {
    if(input[0] == "@") return {username: input.substr(1)};
    if(input.indexOf("://") >= 0) {
        // Parse list
        input = input.split(".com/", 2)[1];
        if(input[0] == "#") input = input.split("#!/", 2)[1];
        var parts = input.split("/", 2);
        return {
            username: parts[0],
            listname: parts[1].split("/", 2)[0]
        }
    }
    return {username: input};
}

function get_results() {
    $("#intro").hide();
    ga('send', 'pageview', '/query');

    var input = $("#username").prop("value");
    if(!input) {
        log("Pick a tweep means put a Twitter username in the input box, like 'shazow'. Try it.");
        return;
    }
    var p = parse_username(input);
    var username = p.username;
    var listname = p.listname;

    var tset_mutual = new TweepSet("Mutual", $("#mutual"));
    var tset_only_following = new TweepSet("Stalking", $("#only_following"));
    var tset_only_followers = new TweepSet("Stalkers", $("#only_followers"));

    var time_start = (new Date).getTime();
    var MAX_FADE = 1000; // When there's too much on the screen, it gets laggy

    check_limit(function() {
        var hits_start = total_api_requests;

        get_social_ids(username, function(r) {
            var expected_total = r['followers'].length + r['following'].length;
            var processed_count = 0;

            // Fill the TweepSet columns
            tset_mutual.set_population(r['mutual']);
            tset_only_following.set_population(r['only_following']);
            tset_only_followers.set_population(r['only_followers']);

            show_thanks(tset_mutual.count, tset_only_following.count, tset_only_followers.count);

            function render_item(item) {
                /* (Called for every item) Notify each TweepSet of a potential new member */
                if(whitelist && !whitelist[item.id]) return; // Descriminate against this tweep.
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

            function completed() {
                /* Callback to trigger when both parallel AJAX chains are done */
                var time_elapsed = (new Date).getTime() - time_start;
                log("Done! Loaded " + processed_count + " tweeps using " + (total_api_requests - hits_start) + " API calls in " + time_elapsed/1000 + " seconds.");
            }

            log("Fetching tweeps: 0%");

            if(!listname) {
                // Start parallel AJAX chains, wee
                var c = new CounterCallback(3, completed);
                load_users(r['mutual'], render_item, iter_callback, c);
                load_users(r['only_following'], render_item, iter_callback, c);
                load_users(r['only_followers'], render_item, iter_callback, c);
            } else {
                load_list_members(username, listname, render_item, iter_callback, completed);
            }
        });
    });
}

function unfollow(screen_name) {
    log("Unfollowing...");
    var api_target = twitter_api_prefix + "/friendships/destroy.json?screen_name=" + screen_name;

    OAuth.post(api_target, {}, function() {
        log("Unfollowed: " + screen_name);
    });
}

function follow(screen_name) {
    log("Following...");
    var api_target = twitter_api_prefix + "/friendships/create.json?screen_name=" + screen_name;

    OAuth.post(api_target, {}, function() {
        log("Followed: " + screen_name);
    });
}

function tweepsect(screen_name) {
    $("#username").prop("value", screen_name);
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

function track_links(selector, category) {
    $('a', selector).on('click', function(e) {
        var url = $(this).attr("href");
        if (e.currentTarget.host != window.location.host) {
            var is_new_tab = e.metaKey || e.ctrlKey || this.target == "_blank";
            var ga_event = {
                'hitType': 'event',
                'eventCategory': category,
                'eventAction': 'click',
                'eventLabel': url.split("?")[0] // Don't track query args.
            };
            if (is_new_tab) {
                ga('send', ga_event);
                return true;
            }

            ga_event['hitCallback'] = function() {
                document.location = url;
            };
            ga('send', ga_event);

            e.preventDefault();
            return false;
        }
    });
};
