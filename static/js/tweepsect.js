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
    if (xoxo_whitelist[tweep.id]) {
        $("a", row).append(' <i class="twitter_sprite xoxo" title="Attending XOXO 2014"></i>');
    }
    if (bb_whitelist[tweep.screen_name]) {
        $("a", row).append(' <i class="twitter_sprite bb" title="Attending Brooklyn Beta 2014"></i>');
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

        if($.isFunction(iter_callback)) {
            var r = iter_callback(data.users.length);
            if (r === false) {
                // Early abort
                if($.isFunction(success_callback)) success_callback();
                return;
            }
        }

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
            listname: parts[1].split("/")[1]
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

    var config = {};
    if (window.location.search) {
        var parts = window.location.search.substr(1).split("&");
        for (var i=0; i<parts.length; i++) {
            var kv = parts[i].split("=");
            config[kv[0]] = kv[1];
        }
    }

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

                if (config.limit && Number(config.limit) < processed_count) {
                    log("Limit reached, stopping early.");
                    return false
                }

                return true
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


var xoxo_whitelist = {"409":1,"414":1,"422":1,"448":1,"541":1,"882":1,"949":1,"1084":1,"1154":1,"1186":1,"1598":1,"1821":1,"2185":1,"2549":1,"2984":1,"3922":1,"4396":1,"4987":1,"4999":1,"5017":1,"5107":1,"5117":1,"5215":1,"5504":1,"5699":1,"5813":1,"6033":1,"6417":1,"6595":1,"6822":1,"6854":1,"7161":1,"7801":1,"7833":1,"8877":1,"9457":1,"10051":1,"10350":1,"10423":1,"10714":1,"10822":1,"10881":1,"11113":1,"11628":1,"11724":1,"11868":1,"12249":1,"12279":1,"12294":1,"12513":1,"12615":1,"12685":1,"12877":1,"12891":1,"12914":1,"12938":1,"13035":1,"13341":1,"13349":1,"13461":1,"13576":1,"14563":1,"15033":1,"16023":1,"18713":1,"21883":1,"22483":1,"24263":1,"25663":1,"26233":1,"26853":1,"30923":1,"33053":1,"33423":1,"33883":1,"34303":1,"35603":1,"36253":1,"36443":1,"36823":1,"38093":1,"38753":1,"41713":1,"41783":1,"43273":1,"46063":1,"46343":1,"49093":1,"51123":1,"51203":1,"54913":1,"57203":1,"57743":1,"65233":1,"74523":1,"78493":1,"83673":1,"86263":1,"109023":1,"112613":1,"128163":1,"182383":1,"187793":1,"289403":1,"302173":1,"379983":1,"409493":1,"460493":1,"482433":1,"509323":1,"514063":1,"616673":1,"633793":1,"635793":1,"638773":1,"641013":1,"643403":1,"647403":1,"649633":1,"651733":1,"656233":1,"657073":1,"666073":1,"673443":1,"675863":1,"680703":1,"681523":1,"682373":1,"682463":1,"695243":1,"716923":1,"734203":1,"754604":1,"755241":1,"755414":1,"755594":1,"756466":1,"758011":1,"759287":1,"760795":1,"761975":1,"763281":1,"768632":1,"771619":1,"772667":1,"774010":1,"774280":1,"778325":1,"782010":1,"784128":1,"784710":1,"784912":1,"785347":1,"787158":1,"792690":1,"793214":1,"794767":1,"796601":1,"798952":1,"802112":1,"804325":1,"804774":1,"805382":1,"807657":1,"810667":1,"812567":1,"813637":1,"814176":1,"816016":1,"817394":1,"818902":1,"818992":1,"820115":1,"821753":1,"822030":1,"823012":1,"823129":1,"823207":1,"824022":1,"852251":1,"862681":1,"869201":1,"875511":1,"876081":1,"883321":1,"896061":1,"925161":1,"930061":1,"944261":1,"956501":1,"956611":1,"962801":1,"980641":1,"1008061":1,"1008591":1,"1048651":1,"1063491":1,"1105671":1,"1124861":1,"1133701":1,"1154511":1,"1184251":1,"1206581":1,"1262791":1,"1266241":1,"1270851":1,"1290621":1,"1317661":1,"1318181":1,"1380471":1,"1422311":1,"1459461":1,"1465161":1,"1465481":1,"1477481":1,"1523501":1,"1530531":1,"1532061":1,"1586871":1,"1592491":1,"1617891":1,"1636901":1,"1747381":1,"1755171":1,"1781201":1,"1788381":1,"1797691":1,"1813571":1,"1853211":1,"1854211":1,"1919231":1,"2052011":1,"2052331":1,"2219131":1,"2254561":1,"2326161":1,"2386451":1,"2399381":1,"2404341":1,"2563081":1,"2622731":1,"2790981":1,"2897431":1,"3076531":1,"3080761":1,"3137231":1,"3163591":1,"3174971":1,"3225381":1,"3361621":1,"3394331":1,"3642001":1,"3688491":1,"3985601":1,"4195221":1,"4439191":1,"4531551":1,"4829901":1,"4930131":1,"4934171":1,"5056501":1,"5162961":1,"5273561":1,"5380022":1,"5382252":1,"5389182":1,"5418912":1,"5424182":1,"5468302":1,"5473342":1,"5603992":1,"5656302":1,"5663182":1,"5693882":1,"5706532":1,"5746882":1,"5749022":1,"5777542":1,"5778712":1,"5793622":1,"5803082":1,"5867112":1,"5867532":1,"5905672":1,"5943422":1,"6016232":1,"6088382":1,"6121442":1,"6144932":1,"6148712":1,"6152702":1,"6154922":1,"6160742":1,"6194102":1,"6316232":1,"6326912":1,"6352012":1,"6352892":1,"6368672":1,"6442312":1,"6490642":1,"6503412":1,"6512322":1,"6514492":1,"6588972":1,"6646752":1,"6666892":1,"6714782":1,"6728562":1,"6757422":1,"6775512":1,"6875952":1,"6981492":1,"7001722":1,"7026992":1,"7054972":1,"7118672":1,"7157722":1,"7191382":1,"7215612":1,"7234652":1,"7284142":1,"7343762":1,"7359642":1,"7535272":1,"7596052":1,"7603032":1,"7669762":1,"7686862":1,"7742162":1,"7801382":1,"7933932":1,"7975582":1,"8039302":1,"8067082":1,"8072642":1,"8190802":1,"8207832":1,"8252462":1,"8253682":1,"8255402":1,"8308622":1,"8315692":1,"8363602":1,"8390102":1,"8419232":1,"8485792":1,"8492382":1,"8501542":1,"8552602":1,"8618132":1,"8632762":1,"8752222":1,"8761172":1,"8848952":1,"8940312":1,"8946022":1,"8950822":1,"8975702":1,"9255782":1,"9270952":1,"9338922":1,"9361392":1,"9368412":1,"9378282":1,"9428232":1,"9445792":1,"9463402":1,"9641922":1,"9866582":1,"9879342":1,"9895472":1,"9987762":1,"10137552":1,"10267352":1,"10360752":1,"10369032":1,"10724012":1,"10791832":1,"10914232":1,"10961962":1,"11098142":1,"11325252":1,"11407702":1,"11491312":1,"11519102":1,"11735032":1,"11760342":1,"11856072":1,"11888112":1,"11927552":1,"11957472":1,"12040482":1,"12070592":1,"12091452":1,"12096622":1,"12145232":1,"12175632":1,"12248262":1,"12294442":1,"12377532":1,"12377822":1,"12421082":1,"12535362":1,"12668332":1,"12772732":1,"12803032":1,"12920742":1,"12992142":1,"13103182":1,"13335562":1,"13443702":1,"13458372":1,"13800412":1,"13860742":1,"13940602":1,"13980622":1,"14052194":1,"14052373":1,"14069365":1,"14097026":1,"14099692":1,"14112869":1,"14113407":1,"14115059":1,"14116243":1,"14125871":1,"14137737":1,"14137882":1,"14150168":1,"14155739":1,"14166501":1,"14167197":1,"14177564":1,"14178728":1,"14180531":1,"14186026":1,"14187249":1,"14189112":1,"14195880":1,"14198319":1,"14199907":1,"14204909":1,"14211807":1,"14211882":1,"14220606":1,"14221104":1,"14224219":1,"14253068":1,"14255152":1,"14263159":1,"14271974":1,"14272503":1,"14288769":1,"14303235":1,"14303954":1,"14312845":1,"14328463":1,"14328506":1,"14330980":1,"14331929":1,"14353975":1,"14356969":1,"14370184":1,"14380400":1,"14397792":1,"14414761":1,"14417135":1,"14471007":1,"14475298":1,"14483134":1,"14510231":1,"14515931":1,"14539307":1,"14541533":1,"14550221":1,"14569079":1,"14574586":1,"14579982":1,"14592020":1,"14607687":1,"14614857":1,"14621681":1,"14628992":1,"14629724":1,"14669224":1,"14688344":1,"14697012":1,"14699828":1,"14701006":1,"14716358":1,"14731011":1,"14731905":1,"14763721":1,"14767632":1,"14780589":1,"14800329":1,"14806423":1,"14807853":1,"14819309":1,"14819901":1,"14829295":1,"14833752":1,"14859264":1,"14860638":1,"14893547":1,"14903327":1,"14903883":1,"14927869":1,"14934367":1,"14947406":1,"14971414":1,"14980933":1,"14983480":1,"14997350":1,"15024090":1,"15049042":1,"15059001":1,"15069435":1,"15071058":1,"15098106":1,"15151706":1,"15159177":1,"15162920":1,"15169697":1,"15172760":1,"15220688":1,"15226263":1,"15239461":1,"15330898":1,"15334523":1,"15345209":1,"15375030":1,"15387870":1,"15390595":1,"15399279":1,"15416046":1,"15428098":1,"15468077":1,"15510016":1,"15537315":1,"15569730":1,"15586792":1,"15604398":1,"15608541":1,"15612035":1,"15617576":1,"15642029":1,"15660494":1,"15662190":1,"15680611":1,"15681643":1,"15682773":1,"15683403":1,"15706128":1,"15723203":1,"15729558":1,"15743396":1,"15763404":1,"15805450":1,"15875557":1,"15876113":1,"15884541":1,"15938093":1,"15947897":1,"16000132":1,"16005107":1,"16022565":1,"16062625":1,"16125720":1,"16252989":1,"16266780":1,"16271827":1,"16286091":1,"16328976":1,"16331614":1,"16331904":1,"16352915":1,"16392799":1,"16393886":1,"16428140":1,"16437301":1,"16467582":1,"16479659":1,"16483747":1,"16515082":1,"16522656":1,"16523003":1,"16570302":1,"16588791":1,"16655768":1,"16663324":1,"16729508":1,"16741826":1,"16784490":1,"16799897":1,"16915910":1,"16933425":1,"17025934":1,"17035875":1,"17046072":1,"17092251":1,"17105539":1,"17142606":1,"17177251":1,"17182189":1,"17192686":1,"17271356":1,"17273108":1,"17296176":1,"17341184":1,"17343876":1,"17345949":1,"17355558":1,"17391571":1,"17426875":1,"17430997":1,"17431654":1,"17432389":1,"17474988":1,"17532167":1,"17576659":1,"17742902":1,"17760048":1,"17814720":1,"17846813":1,"17878608":1,"17917257":1,"17984137":1,"18069838":1,"18092335":1,"18128940":1,"18152849":1,"18183018":1,"18187207":1,"18196758":1,"18212523":1,"18214494":1,"18229128":1,"18246193":1,"18317000":1,"18330119":1,"18348795":1,"18375989":1,"18405153":1,"18418077":1,"18441310":1,"18468638":1,"18665414":1,"18692309":1,"18695490":1,"18708466":1,"18775572":1,"18776317":1,"18818340":1,"18824526":1,"18908446":1,"18988502":1,"19006569":1,"19035047":1,"19084002":1,"19153715":1,"19193287":1,"19194936":1,"19210074":1,"19238265":1,"19254864":1,"19268965":1,"19333113":1,"19612480":1,"19745353":1,"19818279":1,"19895045":1,"19923571":1,"19924413":1,"19982776":1,"20021667":1,"20110439":1,"20122655":1,"20283478":1,"20384189":1,"20420722":1,"20666150":1,"20691442":1,"20729281":1,"20811622":1,"20825732":1,"20949658":1,"20967772":1,"21059960":1,"21166130":1,"21338196":1,"21459150":1,"21500149":1,"21798005":1,"22066285":1,"22118364":1,"22449932":1,"22856668":1,"22921281":1,"22980944":1,"23020351":1,"23141171":1,"23264033":1,"23320205":1,"23339129":1,"23452484":1,"23487429":1,"24499115":1,"24662583":1,"24752584":1,"24989688":1,"25219946":1,"25325530":1,"25401571":1,"25845867":1,"25890180":1,"25958131":1,"26254626":1,"26305496":1,"26430983":1,"26465257":1,"26612436":1,"26706833":1,"27809570":1,"27993405":1,"28286772":1,"28363528":1,"29089557":1,"29100735":1,"29458070":1,"29731936":1,"29983456":1,"30391561":1,"30689021":1,"30732254":1,"30948908":1,"30949085":1,"31182608":1,"31478923":1,"31664653":1,"31665210":1,"31977286":1,"32124032":1,"32166655":1,"34030003":1,"34342176":1,"34387624":1,"34501014":1,"34517654":1,"34608722":1,"34951303":1,"36391242":1,"36788811":1,"36994785":1,"37008538":1,"37061669":1,"37143407":1,"39815274":1,"40262799":1,"40437414":1,"40596237":1,"40959851":1,"41541749":1,"41676703":1,"42569621":1,"42677879":1,"42750234":1,"43030995":1,"43327200":1,"43380643":1,"43473059":1,"43560706":1,"44683117":1,"45354922":1,"45467344":1,"45770468":1,"45784665":1,"45856544":1,"45976653":1,"47840605":1,"48188423":1,"48569578":1,"48913382":1,"50441614":1,"50781713":1,"50874228":1,"52551079":1,"54185484":1,"54638025":1,"55462730":1,"56210849":1,"56607634":1,"56768257":1,"58082518":1,"58314646":1,"58858319":1,"58939141":1,"58961325":1,"59218280":1,"60187947":1,"60677703":1,"61592079":1,"61697390":1,"61823358":1,"62219107":1,"62530673":1,"63636163":1,"64853040":1,"67202886":1,"67825149":1,"68211507":1,"68981132":1,"69324576":1,"71261579":1,"71351519":1,"72745585":1,"72890671":1,"73619718":1,"74262125":1,"78119315":1,"78119712":1,"80052616":1,"81322895":1,"81879407":1,"82993674":1,"83089937":1,"83996344":1,"85841281":1,"86412031":1,"90028497":1,"90488105":1,"91163320":1,"91410410":1,"91722164":1,"94672487":1,"94846538":1,"97263561":1,"98518430":1,"99886636":1,"101190175":1,"104494489":1,"104745184":1,"106935057":1,"107801105":1,"110716686":1,"111005635":1,"111032147":1,"112075585":1,"112524101":1,"114853731":1,"115560394":1,"118279350":1,"119156670":1,"119978245":1,"121880060":1,"123601500":1,"126854537":1,"127575007":1,"128904040":1,"130584519":1,"130897706":1,"132655885":1,"133058038":1,"133424508":1,"135856194":1,"136400506":1,"138528012":1,"139504833":1,"143209548":1,"143702545":1,"149001999":1,"150764358":1,"152115336":1,"152427726":1,"157097806":1,"158272788":1,"161369987":1,"163202841":1,"166301775":1,"168786885":1,"176233506":1,"180173919":1,"180306193":1,"181703779":1,"182616152":1,"182781508":1,"186833531":1,"190919583":1,"194663014":1,"195485269":1,"195863654":1,"197506631":1,"197896861":1,"198695654":1,"203063180":1,"205931347":1,"208202638":1,"210740328":1,"214668433":1,"218558150":1,"226976689":1,"227384429":1,"228823192":1,"229237555":1,"230355105":1,"237262300":1,"244137444":1,"244268839":1,"248701234":1,"249921736":1,"252672062":1,"258398014":1,"266430754":1,"267571446":1,"269386849":1,"271170435":1,"272591364":1,"277071665":1,"277100051":1,"281602070":1,"282464049":1,"284771521":1,"290879947":1,"291551746":1,"295177545":1,"298656296":1,"305804765":1,"310358968":1,"312292673":1,"322234819":1,"323159151":1,"325044817":1,"334490355":1,"344102160":1,"345108623":1,"348082699":1,"354702266":1,"356445530":1,"361606325":1,"365709939":1,"365743287":1,"369958119":1,"374300583":1,"380132681":1,"384239522":1,"384595521":1,"386316205":1,"390856908":1,"392857249":1,"393187879":1,"395079586":1,"396619347":1,"403697545":1,"415114043":1,"415841157":1,"417372853":1,"421378286":1,"433528915":1,"441299438":1,"442522102":1,"443890146":1,"446580276":1,"448658889":1,"451622038":1,"454676858":1,"461789840":1,"466247755":1,"483160795":1,"484972857":1,"486784693":1,"497734629":1,"505010661":1,"509010059":1,"527123659":1,"543963933":1,"545655040":1,"547064680":1,"556221314":1,"577124971":1,"582995890":1,"614119818":1,"620641874":1,"632372439":1,"720676111":1,"737532842":1,"801832062":1,"811989608":1,"817926673":1,"830275986":1,"833716784":1,"867044976":1,"885210589":1,"887397150":1,"937157598":1,"970428030":1,"971175494":1,"980592128":1,"1030894430":1,"1034100738":1,"1037602843":1,"1081552194":1,"1135186555":1,"1222860967":1,"1321418522":1,"1383137149":1,"1400270070":1,"1403488736":1,"1499456916":1,"1529824129":1,"1535018935":1,"1596549006":1,"1653962647":1,"1716377460":1,"1747323823":1,"1849455895":1,"2192342638":1,"2202601008":1,"2224536139":1,"2298999144":1,"2361849645":1,"2372256686":1,"2451986203":1,"2465248892":1,"2482264920":1,"2519693923":1,"2520815526":1,"2525954834":1,"2579675988":1,"2586191162":1,"2586231302":1,"2586236749":1,"2586262430":1,"2586483258":1,"2586654001":1,"2593828616":1,"2597597528":1,"2776966532":1};
var bb_whitelist = {"ajkandy":1,"Grrrando":1,"aharmonica":1,"aaronmatys":1,"aq":1,"aaronrobbs":1,"ableparris":1,"adambrault":1,"AdamChlan":1,"kurzawapower":1,"adammiller":1,"Robeam":1,"mradamdavis":1,"tranzfuse":1,"addabjork":1,"adrianparsons":1,"proledufay":1,"aemeredith":1,"agfabrega":1,"aidanfeldman":1,"tweetalbert":1,"cacheop":1,"prankstanic":1,"alexwcarl":1,"grafyte":1,"polarbearBK":1,"alex_handley":1,"cubedweller":1,"alexmlkn":1,"awkale":1,"alexgrantwright":1,"heyblackbox":1,"alexandrelynn":1,"protectorofman":1,"alexdao":1,"alexandriadumbo":1,"alexisfellenius":1,"_alicia_brooks":1,"allegraburnette":1,"allenylau":1,"schmalliso":1,"alonzofelix":1,"amandamccormick":1,"amberaultman":1,"amberebrown":1,"superamit":1,"Amita":1,"am3thyst":1,"amydearest":1,"anandx":1,"andreortiz":1,"pnts":1,"andreasb":1,"schjonhaug":1,"a":1,"Andrw_w":1,"andrewcohen":1,"amotion":1,"betavi11e":1,"McAndrew":1,"merc":1,"aljosenge":1,"andybudd":1,"andymcmillan":1,"officiallyrad":1,"aweissman":1,"dotgriddotcom":1,"anishaj":1,"structAnkit":1,"annaphillipsnz":1,"adeggs":1,"annbol":1,"anniesmidt":1,"mantwan":1,"agentile":1,"April_Hayward":1,"ara818":1,"arifhuda2":1,"arvid_a":1,"royalpalmsclub":1,"audreyhtan":1,"a_wlkr":1,"designbyaviva":1,"ayahbdeir":1,"badfeather":1,"baratunde":1,"basberkhout":1,"becarella":1,"bedrich":1,"uberbek":1,"blumenfeld":1,"benjivegemite":1,"Benzoh":1,"benjordan":1,"benpeck":1,"pieratt":1,"ramsey":1,"bensalinas":1,"benjamindauer":1,"bermonpainter":1,"uberboom":1,"nuechterlein":1,"billytobon":1,"birk":1,"blaindy":1,"BobTroia":1,"bobbyjgeorge":1,"boonerang":1,"brandonhoulihan":1,"Sheatsb":1,"Falkowski":1,"swansino":1,"noSlouch":1,"bfeeney":1,"behoff":1,"brianlaungaoaeh":1,"brianlsf":1,"brianmcallister":1,"lanewinfield":1,"mrwarren":1,"farevaag":1,"bryanlives":1,"bryanrmartin":1,"bryanzug":1,"bryantflorez":1,"budparr":1,"calebd":1,"Calebrotach":1,"fictivecameron":1,"cameronmoll":1,"carlrc":1,"postcarl":1,"caseywest":1,"rose22":1,"celinecelines":1,"gem_ray":1,"chandlervdw":1,"chapterthree":1,"cadler":1,"GiantLeap":1,"chad_rogers":1,"superfection":1,"ceonyc":1,"ThaxterChelsea":1,"Armstrong":1,"chrisbaglieri":1,"cjbell_":1,"Chrubo":1,"chrisbowler":1,"chrisbreikss":1,"ccarella":1,"medium_one":1,"placenamehere":1,"Chrisguimarin":1,"chrisjamesbk":1,"ckurdziel":1,"maliwat":1,"prolificchris":1,"chrisnojima":1,"cobrien411":1,"chrispetescia":1,"chrisradford":1,"chrisrushing":1,"shiflett":1,"__chris_smith__":1,"cmstone":1,"sutterbomb":1,"tenaciouscb":1,"christianross":1,"christinabeard":1,"lalaalaaa":1,"christinabklyn":1,"gbks":1,"christauziet":1,"cdavis565":1,"chrisfahey":1,"chrislobay":1,"fehler":1,"ischriswilliams":1,"cjse":1,"clairemarines":1,"claresutcliffe":1,"clarissa":1,"cloudred":1,"dotdothashtag":1,"thepanorama":1,"yayconnie":1,"conchan":1,"conorwade":1,"frauholle15":1,"courtney271":1,"letsallgotothe":1,"craigcannon":1,"acraigwilliams":1,"_cz":1,"cr8tonmershon":1,"cynthiapink":1,"dkr":1,"oolah":1,"danmorris427":1,"dan_degrandpre":1,"danielcgold":1,"danielmall":1,"danimalnelson":1,"dan_shin":1,"danieljsullivan":1,"dweldonnyc":1,"TSiMH":1,"campoverdi":1,"howells":1,"danielmahal":1,"danielromlein":1,"danielweinand":1,"dwnr11217":1,"danielwilber":1,"wolfson":1,"reflectingpool":1,"daniellereisch":1,"AkaDonnyQ":1,"dbow1234":1,"Dalblas":1,"daphnelin":1,"holidaymatinee":1,"davedawson":1,"desandro":1,"BigLittleFlan":1,"davekellam":1,"davatron5000":1,"dgbrahle":1,"irondavy":1,"ddemaree":1,"mrjewell":1,"dsjoerg":1,"davidkaneda":1,"stuntbox":1,"tangentialism":1,"davidyeiser":1,"dawntweet":1,"dayjimenez":1,"dcdomain":1,"DeanCooney":1,"dearidears":1,"deepshah":1,"democraticTRVLR":1,"Dennispkramer":1,"denykhoung":1,"djaawn":1,"pixeljanitor":1,"drk":1,"deroyperaza":1,"devinelizabeth":1,"youngdevin":1,"frooblor":1,"dlimeb":1,"uxdiogenes":1,"divisionof":1,"Dlipkin":1,"drbparsons":1,"donalddesantis":1,"stop":1,"drewnichols1974":1,"DuncanFalk":1,"alphex":1,"dustanner":1,"duyhtq":1,"du_din_kambo":1,"dylangreif":1,"eburd":1,"funkatron":1,"edmullen":1,"ednacional":1,"Edith":1,"eduardonemeth":1,"edwardlepine":1,"edwerd":1,"stenejohansen":1,"einarlove":1,"elirousso":1,"elida_ca":1,"ElizabethN":1,"elliotjaystocks":1,"elyseviotto":1,"e_v_miller":1,"emlaser":1,"emilyokey":1,"emily_hampton":1,"enriqueallen":1,"_EricHu":1,"pushred":1,"emdbrooklyn":1,"e_olsen":1,"stavn":1,"prolificeric":1,"ericaheinz":1,"ericfenny":1,"kissane":1,"everyplace":1,"ethanbodnar":1,"beep":1,"ethanS_G":1,"ethnt":1,"sirevanhaas":1,"fadking":1,"fahmsikder":1,"fatima":1,"ffangohr":1,"medianueva":1,"franciscohui":1,"Frank_Battaglia":1,"fchimero":1,"frankko":1,"tralition":1,"fridmangallery":1,"_GabeMarquez":1,"gabimoore":1,"hidinginabunker":1,"radarboy":1,"gedpalmer":1,"topfunky":1,"stonehippo":1,"gerardramos":1,"gerardodm":1,"hellogeri":1,"rogers":1,"glennsidney":1,"gojomo":1,"gracekimgd":1,"grahamblevins":1,"gsiener":1,"gblakeman":1,"greg_a":1,"gbeck419":1,"thegreghoy":1,"GreggMyr":1,"Gschwa":1,"GCHANANGE":1,"guygood2":1,"haleymcmichael":1,"hannakulin":1,"HGhijsen":1,"Hghijsen":1,"hansv":1,"heidichisholm":1,"birdmeat":1,"helena":1,"todd_sundsted":1,"sztul":1,"hermanradtke":1,"hilaryburt":1,"hmason":1,"HoeflerCo":1,"hollytiwari":1,"house":1,"Hughweber":1,"iancoyle":1,"heavymeta":1,"ianhunter":1,"ianpatrickhines":1,"endashes":1,"ianstormtaylor":1,"ICondensed":1,"IntiOcean":1,"studioroxas":1,"isayhello":1,"Burciaga":1,"justinpocta":1,"Jc":1,"jacecooke":1,"jackcheng":1,"jackosborne":1,"jackiebackwards":1,"jacksonlatka":1,"jbok4":1,"jacobkrupnick":1,"jrlevine":1,"jkmcrg":1,"jakeprzespo":1,"jstutzman":1,"jakezucker":1,"averyj":1,"James_bergen":1,"LaCroixDesign":1,"jamesdeangelis":1,"imjameshall":1,"jamessocol":1,"jturnley":1,"jameswidegren":1,"jmwlsn":1,"jaminjantz":1,"janelindberg":1,"janinetoro":1,"jaredhales":1,"Jason_morrow":1,"campbellgraphic":1,"jasonfounts":1,"jasonakellum":1,"jasonlong":1,"jasonquintin":1,"jasonsantamaria":1,"textfiles":1,"javan":1,"jaygoldman":1,"jayrobinson":1,"JECowgill":1,"jedo":1,"jedmeade":1,"jedschmidt":1,"na":1,"NA":1,"jeff_devine":1,"jeffdomke":1,"druryjeff":1,"grayfuse":1,"jeffheuer":1,"jefflagasca":1,"phishy":1,"hijeffma":1,"jeffuthaichai":1,"jefficly":1,"jenbee":1,"Jenniration":1,"jenschuetz":1,"jensimmons":1,"jenaenae":1,"jennlukas":1,"renrutnnej":1,"uxjenn":1,"jschwartzdesign":1,"jenniferbrook":1,"jen_mcfadden":1,"jnfrwg":1,"geometricjenny":1,"miahzinn":1,"jeremygtech":1,"jeremy_jackson":1,"jeremyjantz":1,"adactio":1,"jeremyloughnot":1,"jeremyzilar":1,"jes_sherborne":1,"jessic":1,"jess3":1,"ChasingUX":1,"plasticmind":1,"jesseinman":1,"jessiarrington":1,"sunfeet22":1,"jessicahische":1,"jkheltzel":1,"jkutik":1,"jillnussbaum":1,"jillianadel":1,"jilliannichols":1,"jimjones":1,"jalmendares":1,"lindyblues":1,"skajoa":1,"joancmcgrath":1,"joannagoddard":1,"jgebbia":1,"mrjoe":1,"joeminkie":1,"joemorgano":1,"joetutterow":1,"notdetails":1,"jglovier":1,"FeedJoelPie":1,"rasskull":1,"itzjshine":1,"johan_lilja":1,"johannakoll":1,"john_cogs":1,"iamjohnford":1,"hams":1,"niederme":1,"ultranaut":1,"pents90":1,"jokedewinter":1,"rooftopzen":1,"jonchretien":1,"dotjay":1,"jongr":1,"jonhackett_":1,"smartassdesign":1,"jonheslop":1,"jonmadison":1,"basker":1,"jonmarkgo":1,"jonnyliebs":1,"songadaymann":1,"moore":1,"jonathanmotzkin":1,"jonathanpberger":1,"destroytoday":1,"gringomoses":1,"jordankoschei":1,"JordonMowbray":1,"jorgelo":1,"Sensibleworld":1,"joshuabaker":1,"jbrewer":1,"joshcogs":1,"joshdcomp":1,"joshcrowder":1,"jgut":1,"JGut":1,"joshking":1,"joshknowles":1,"joshlong":1,"joshsmithnyc":1,"josh_stewart":1,"jstylman":1,"joshsucher":1,"jayemsee":1,"fmr_on":1,"endtwist":1,"sortino":1,"jperras":1,"jpkoudstaal":1,"jstorplants":1,"juliaparris":1,"juliazeltser":1,"julien51":1,"oubliette":1,"jupitercow":1,"justenholter":1,"justinc":1,"jmdickinson":1,"jedmund":1,"hello_justin":1,"justinSmithChi":1,"kaitew213":1,"kajdro":1,"katarinayee":1,"katekiefer":1,"katemstern":1,"kathleenw":1,"chicalashaw":1,"8apixel":1,"katie__k":1,"madebykatie":1,"katygarrison":1,"Kavla":1,"keenancummings":1,"keirwhitaker":1,"kebormuth":1,"keithholjencin":1,"kellianderson":1,"kellyclaws":1,"kellysutton":1,"kelseyfoster":1,"kevinrupert":1,"kskobac":1,"restlessdesign":1,"infargible":1,"kickassidy":1,"octothorpnyc":1,"kilmc":1,"killianshiflett":1,"NhuKim":1,"kimnortman":1,"kradtke35":1,"kimbost":1,"DuaneKing":1,"kirkphelps":1,"kitt":1,"kristenjoy":1,"kristiankim":1,"kristie_ux":1,"moekristin":1,"littlemissku":1,"krystynheide":1,"kuanluo":1,"kylepgh":1,"Kylemeyer":1,"kneath":1,"kyleruane":1,"kyteague":1,"lachlanhardy":1,"larrylegend":1,"larsbaek":1,"lashakrikheli":1,"lateisha":1,"lolarose888":1,"hechanova":1,"laurentredding":1,"LeeRubenstein":1,"leesawytock":1,"leilaboujnane":1,"leland":1,"daycalligraphy":1,"lasslaby":1,"lindseybradford":1,"Linndelicate":1,"lisajamhoury":1,"bobulate":1,"liz_starin":1,"DesignLiza":1,"SoundsLocke":1,"louisrosenfeld":1,"luc_io":1,"theinvisibledog":1,"lkwds":1,"younglucas":1,"luzbonita":1,"lydiastory":1,"lydiamann":1,"asealamb":1,"manda_cfb":1,"aworkinglibrary":1,"marazepeda":1,"marcosuarez":1,"mmayer344":1,"mlpCreative":1,"coderella":1,"maritaviken":1,"unihead":1,"markboulton":1,"markdicristina":1,"markdorison":1,"garbnzgh":1,"wmdmark":1,"smkiv":1,"alien_resident":1,"marksdiner":1,"markweaver":1,"markonen":1,"hellbox":1,"polaroidgrrl":1,"demonaday":1,"codingdesigner":1,"mat_stevens":1,"mhrescak":1,"permakittens":1,"100matts":1,"Matt_Ceccarelli":1,"Matt_chisholm":1,"mattdonovan":1,"Mattford":1,"mhkt":1,"matthall2000":1,"mattlehrer":1,"mattluckhurst":1,"mpakes":1,"perrygerard":1,"mattbot":1,"pxlt":1,"mattangriffel":1,"Ampersanderson":1,"Fotoverite":1,"mrb":1,"MTTHWBSH":1,"matthewcrist":1,"mattrobs":1,"mattklein_":1,"mstellato":1,"derrellwilliams":1,"maxfenton":1,"maxshelley":1,"Maxwhitney":1,"mayabruck":1,"miekd":1,"owltastic":1,"mbe":1,"ghostlymeg":1,"megangilman":1,"melwire":1,"OperationNICE":1,"melmotz":1,"melissashow":1,"msmeredithblack":1,"petito_dito":1,"mialoira":1,"bsidesnarrative":1,"mikez":1,"bergatron":1,"yewknee":1,"michaeldfoley":1,"kdrive":1,"mckelvaney":1,"michaeloh86":1,"mperrotti":1,"mikesmith187":1,"mkwng":1,"mikedweiss":1,"Williams":1,"michaelyuan":1,"mleland":1,"MichalKras":1,"michellemerrrrr":1,"migreyes":1,"bemiguel":1,"Mborsare":1,"mike_dory":1,"mfortress":1,"michaelrfowler":1,"meyer":1,"mikepro_":1,"mtrozzo":1,"thee_wolf":1,"milesfitzgerald":1,"mister_mr":1,"krlmz":1,"natalievi":1,"natalierachel":1,"nateabele":1,"boltron":1,"nathan_scott":1,"_ngould":1,"nnewbold":1,"weightshift":1,"neilnanderson":1,"neilw":1,"nelsonjoyce":1,"NguyetV":1,"nicatnyt":1,"nicdev":1,"nwe44":1,"ncuomo":1,"nickjonastic":1,"nicholaskro":1,"NickMasch":1,"heavi5ide":1,"Nickmyer5":1,"nickisnoble":1,"nicksloan":1,"nickstamas":1,"nkorzenko":1,"nicktual":1,"sodevious":1,"nicoleslaw":1,"nlevin":1,"nhlennox":1,"omar12":1,"one":1,"ringmaster":1,"palebluejen":1,"paperequator":1,"pat":1,"Patriciasaid":1,"pdurginbruce":1,"patrickjmorris":1,"PatrickStrange":1,"paulandrewcline":1,"paulbloore":1,"paul_johnson":1,"paulmiard":1,"preinheimer":1,"iampaulacano":1,"patrickbjohnson":1,"perryazevedo":1,"gustavthree":1,"Peterbarth":1,"badboyboyce":1,"meetar":1,"petragregorova":1,"apostraphi":1,"immunda":1,"pkneer":1,"phillapier":1,"ESWAT":1,"Pippipsi":1,"philiprhie":1,"PointerCreative":1,"prachipun":1,"prestonpesek":1,"PRITIKAN":1,"rachcraft":1,"rlovinger":1,"plasticsoda":1,"mexikansan":1,"thereisnocat":1,"themexican":1,"ravejk":1,"raygunray":1,"redantler":1,"standard_humans":1,"always_kizil":1,"reidhitt":1,"RellyAB":1,"renatepinggera":1,"rendamorton":1,"Ruegrl":1,"rich_harris":1,"frogandcode":1,"richziade":1,"MisterVersatile":1,"rickmesser":1,"rickyrobinett":1,"rdholakia":1,"rjgnyc":1,"ropurushotham":1,"hinchcliffe":1,"trueitalic":1,"rmarscher":1,"robweychert":1,"f1fe":1,"rougebert":1,"roberteerhart":1,"robertlenne":1,"xz":1,"RobertVinluan":1,"RodrigoSanchez":1,"rongoldin":1,"RonaldNelson":1,"rorypetty":1,"yarrcat":1,"roselaguana":1,"RosieCLTRG":1,"roytatum":1,"Twitarrow":1,"iamrumz":1,"strangenative":1,"RuthHardy":1,"unruthless":1,"ryanbarresi":1,"ryanessmaker":1,"ryangiglio":1,"ryangoodman":1,"ryanhefner":1,"mm_robbins":1,"rydercarroll":1,"SairBares":1,"sambeckerdesign":1,"sambrown":1,"sdfdesign4":1,"mistersmalluk":1,"soffes":1,"valenti":1,"SamanthaToy":1,"Ruluks":1,"sangitapshah":1,"Saracannon":1,"starsoup7":1,"sazzy":1,"sarahsampsel":1,"rubyist":1,"scottbelsky":1,"scott_mccaughey":1,"srobbin":1,"scottstemke":1,"sstrudeau":1,"coates":1,"seanwes":1,"sperte":1,"seanpreston":1,"parksebastien":1,"sethdaggett":1,"sgddesign":1,"shalinpei":1,"shanemac":1,"shanezucker":1,"shannnonb":1,"shildner":1,"shawn_grant":1,"iamshawngregg":1,"shell7":1,"shyamagolden":1,"simenbrekken":1,"colly":1,"diversionary":1,"sisi_recht":1,"skipklintworth":1,"sskylar":1,"smkk_studios":1,"espantalha45":1,"snookca":1,"sic_org":1,"solitonsound":1,"solunasoluna":1,"nudgedesign":1,"mshaasnoot":1,"staserz":1,"thisisstar":1,"stefangoodchild":1,"steph_hay":1,"mrstephenbeck":1,"sdidonato":1,"Thoughtmerchant":1,"jenos2085":1,"schlaf":1,"t8ro":1,"stevenepeterman":1,"sueapfe":1,"SwiftAlphaOne":1,"sylviawehrle":1,"none":1,"taliagreismann":1,"t":1,"TaraDeliberto":1,"bombayhustle":1,"tashmahal":1,"tatelucas":1,"tdavidson":1,"ctaylorgreene":1,"tedismert":1,"teganshiflett":1,"klou":1,"mgrassotti":1,"treemershon":1,"tiegz":1,"timboelaars":1,"timbrown":1,"TimHops":1,"timhwang":1,"tmrly":1,"timriot":1,"newforms":1,"iamtimhoover":1,"timothymeaney":1,"tinaessmaker":1,"swissmiss":1,"tobestobs":1,"schneidertobias":1,"toddwickersty":1,"tomg":1,"tomnagle":1,"xiian":1,"toreholmberg":1,"ambienttraffic":1,"limedaring":1,"qwerkal":1,"trentwalton":1,"TrevorBaum":1,"trevorgrogers":1,"feesh":1,"tuesdaybassen":1,"kittycountry":1,"thegaw":1,"fictivetyler":1,"tylrrbrts":1,"tylershick":1,"tysongach":1,"ultravirgo":1,"fictiveulysses":1,"vlh":1,"valenciocardoso":1,"lytchi":1,"vravindran":1,"kottas":1,"torilangford":1,"vijaymathews":1,"vikkinyc":1,"vinniedean":1,"viz":1,"cinzano":1,"vonlampard":1,"w5mith":1,"wesellsocks":1,"wesleyverhoeve":1,"have":1,"whistle":1,"wkayh":1,"whitneyhess":1,"willg":1,"juptrking":1,"williammeeker":1,"wspencer":1,"wimsegers":1,"slow3":1,"XiyaoYang":1,"helloxander":1,"yannell":1,"yarcom":1,"yasuyotakeo":1,"yaykyle":1,"yingy1016":1,"youngna":1,"yuebwang":1,"Zachmattheus":1,"zackvbrady":1,"zmcghee":1,"zacksears":1,"zainy":1,"zakj":1,"zakness":1,"zeb":1,"zroger":1,"avehouse":1,"jina":1,"typeis4lovers":1};
